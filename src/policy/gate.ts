/**
 * enforce() — the single door to the surface adapter (SPEC.md
 * invariant #1, Section 8). Every action, from discovery or replay,
 * passes through this one function before it ever reaches
 * SurfaceAdapter.act(). There is exactly one call site that hands an
 * action to an adapter, and it is inside this gate's caller (the
 * replay engine / discovery loop), never anywhere else.
 *
 * Two independent checks, both fail-closed:
 *   1. Origin + route allowlist, checked after URL normalisation
 *      (EDGE-19) — this also covers passive navigation (EDGE-08): the
 *      replay/discovery loop calls `checkOriginAndRoute` directly on
 *      the URL returned by every observe(), not just on navigate
 *      actions, so a meta-refresh or SSO bounce can't slip past the
 *      gate just because nothing "acted".
 *   2. Irreversibility. A step's own declared `risk` is trusted only in
 *      replay mode (it went through discovery's mandatory verification
 *      replay and lives in a reviewed, versioned artifact). The
 *      independent policy-rule check against the actual target
 *      (`irreversible_actions`) runs in BOTH modes regardless, and can
 *      only ever escalate a decision toward more caution — a policy
 *      match forces require_approval even over a replay step's own
 *      risk:"safe" claim, and discovery's model is never allowed to
 *      self-certify an action as safe (invariant #1) in the first place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ActionT } from "../schema/action.js";
import type { CapabilityT, StepT } from "../schema/artifact.js";

const PolicyIrreversibleRule = z
  .object({
    action_type: z.enum(["navigate", "click", "type", "select", "read"]),
    /** Both optional filters must match if present; an empty rule (neither set) matches any target. */
    role: z.string().optional(),
    name_pattern: z.string().optional(),
  })
  .strict();

const RedactionPattern = z
  .object({
    name: z.string().min(1),
    pattern: z.string().min(1),
  })
  .strict();

export const Policy = z
  .object({
    allowed_origins: z.array(z.string().min(1)),
    allowed_routes: z.array(z.string().min(1)),
    allowed_action_types: z
      .object({
        discovery: z.array(z.string()),
        replay: z.array(z.string()),
      })
      .strict(),
    irreversible_actions: z.array(PolicyIrreversibleRule).default([]),
    redaction_patterns: z.array(RedactionPattern).default([]),
    max_steps: z.number().int().positive(),
    max_duration_ms: z.number().int().positive(),
  })
  .strict();
export type PolicyT = z.infer<typeof Policy>;

export function loadPolicy(data: unknown): PolicyT {
  return Policy.parse(data);
}

const DEFAULT_POLICY_PATH = fileURLToPath(new URL("./policy.default.json", import.meta.url));
const DEFAULT_POLICY: PolicyT = loadPolicy(JSON.parse(readFileSync(DEFAULT_POLICY_PATH, "utf-8")));

export interface EnforceContext {
  url: string;
  artifact?: CapabilityT;
  step?: StepT;
  mode: "discovery" | "replay";
}

export type EnforceDecision =
  | { decision: "allow" }
  | { decision: "block"; reason: string }
  | { decision: "require_approval"; reason: string };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` = any characters except `/`; `**` = any characters at all. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
    } else if (glob[i] === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegExp(glob[i] as string);
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Checks a URL's origin and route against the allowlist, AFTER URL
 * normalisation (EDGE-19: the WHATWG URL parser collapses `..`
 * dot-segments during parsing, so `/safe/../admin` is checked as
 * `/admin`, not as the literal unresolved string).
 *
 * Exported standalone (not just used inside enforce()) because
 * EDGE-08 requires this same check to run after every observe() call,
 * not only when an action is about to navigate — passive redirects
 * (meta-refresh, SSO bounce, a timeout page) are not actions and would
 * otherwise never reach enforce() at all.
 */
export function checkOriginAndRoute(rawUrl: string, policy: PolicyT = DEFAULT_POLICY): EnforceDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { decision: "block", reason: `unparseable url: ${rawUrl}` };
  }

  if (!policy.allowed_origins.includes(parsed.origin)) {
    return { decision: "block", reason: `origin '${parsed.origin}' is not in the allowlist` };
  }
  const routeOk = policy.allowed_routes.some((pattern) => globToRegExp(pattern).test(parsed.pathname));
  if (!routeOk) {
    return { decision: "block", reason: `route '${parsed.pathname}' is not in the allowlist` };
  }
  return { decision: "allow" };
}

function classifyIrreversible(action: ActionT, ctx: EnforceContext, policy: PolicyT): boolean {
  if (ctx.mode === "replay" && ctx.step?.risk === "irreversible") return true;

  const target = ctx.step?.target;
  if (!target || target.primary.by !== "role_name") return false;
  const { role, name } = target.primary;

  return policy.irreversible_actions.some((rule) => {
    if (rule.action_type !== action.type) return false;
    if (rule.role && rule.role !== role) return false;
    if (rule.name_pattern && !(name && new RegExp(rule.name_pattern).test(name))) return false;
    return true;
  });
}

/**
 * The single door to the adapter. `policy` defaults to the loaded
 * policy.default.json so callers can invoke `enforce(action, ctx)`
 * exactly as SPEC.md Section 8 fixes the signature; the explicit third
 * parameter exists for tests and for a future per-tenant policy file
 * (artifact.target.policy_ref already carries that path in the schema).
 */
export function enforce(action: ActionT, ctx: EnforceContext, policy: PolicyT = DEFAULT_POLICY): EnforceDecision {
  const allowedTypes = policy.allowed_action_types[ctx.mode];
  if (!allowedTypes.includes(action.type)) {
    return { decision: "block", reason: `action type '${action.type}' is not permitted in ${ctx.mode} mode` };
  }

  const currentCheck = checkOriginAndRoute(ctx.url, policy);
  if (currentCheck.decision !== "allow") return currentCheck;

  if (action.type === "navigate") {
    const destination = /^https?:\/\//.test(action.url) ? action.url : new URL(action.url, ctx.url).toString();
    const destinationCheck = checkOriginAndRoute(destination, policy);
    if (destinationCheck.decision !== "allow") return destinationCheck;
  }

  if (classifyIrreversible(action, ctx, policy)) {
    return { decision: "require_approval", reason: "action is classified irreversible" };
  }

  return { decision: "allow" };
}
