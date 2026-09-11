/**
 * The capability artifact schema (SPEC.md Section 6). This is the
 * highest-weighted artefact in the project — treat it as the design
 * document, not a data-transfer afterthought.
 *
 * Five fields carry the real design argument (defended at length in
 * REPORT.md Section 2 — see SPEC.md Section 14):
 *   - `inputs` / `outputs`  : typed contract, makes this a callable
 *     capability rather than a recorded macro.
 *   - `steps[].expect`      : a per-step assertion, what makes replay
 *     non-blind instead of a scripted click sequence.
 *   - `outcomes`            : business results are a peer of success in
 *     the published contract, not something the caller has to infer
 *     from a thrown error.
 *   - `overlays`            : the whole multi-tenant reuse story in one
 *     field — sparse patches keyed by step/outcome id, re-validated
 *     against this same schema after merge.
 *   - `capability.status`   : gates unattended execution (draft artifacts
 *     refuse replay without `--allow-draft`).
 * Every other field's justification is inline below, in a doc comment
 * on the field it documents, per SPEC.md Section 14's page-budget rule.
 */
import { z } from "zod";
import { Action, ParamOrLiteral } from "./action.js";

const SEMVER = /^\d+\.\d+\.\d+$/;

export const SCHEMA_VERSION = "1.0.0";

// ---------------------------------------------------------------------
// Locators and targets
// ---------------------------------------------------------------------

/**
 * How a single control is identified. Four strategies, ordered here
 * from most to least robust when used as a `primary` locator:
 * `role_name` (accessibility role + accessible name — survives markup
 * rewrites), `label_text` (associated `<label for>`), `attribute` (a
 * raw DOM attribute — brittle but sometimes the only stable thing on a
 * legacy page), and `scoped_position` (index within a named container —
 * last resort, and EDGE-04 forbids deriving its index from data that
 * varies with the input).
 */
export const Locator = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("role_name"),
      role: z.string().min(1),
      /** Optional: omit to match by role alone (e.g. counting all "row" elements for an outcome detector). */
      name: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ by: z.literal("label_text"), text: z.string().min(1) }).strict(),
  z.object({ by: z.literal("attribute"), attr: z.string().min(1), value: z.string().min(1) }).strict(),
  z
    .object({
      by: z.literal("scoped_position"),
      container_role: z.string().min(1),
      container_name: z.string().min(1),
      role: z.string().min(1),
      index: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type LocatorT = z.infer<typeof Locator>;

export const TargetScope = z
  .object({
    /** Ordered frame chain from the top document to the target's frame. */
    frame_path: z.array(z.string()).optional(),
  })
  .strict();

/**
 * A resolvable target: a primary locator plus ordered fallbacks tried
 * in sequence if the primary fails (see EDGE-06: exhausting the list
 * without landing on exactly one element is a hard failure — the
 * engine never takes "the first match" among several).
 */
export const TargetSpec = z
  .object({
    scope: TargetScope.optional(),
    primary: Locator,
    fallbacks: z.array(Locator).default([]),
  })
  .strict();
export type TargetSpecT = z.infer<typeof TargetSpec>;

// ---------------------------------------------------------------------
// Conditions (shared by step.expect, success.checkpoint, outcomes[].detector)
// ---------------------------------------------------------------------

/**
 * `target` for a condition is either `"$self"` (the current step's own
 * target — used by `field_value_equals` right after a `type` action,
 * EDGE-16) or a standalone locator (used by checkpoints/detectors that
 * assert about a different element than the one the step just acted on).
 */
const ConditionTarget = z.union([z.literal("$self"), Locator]);

const LeafCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("field_value_equals"), target: ConditionTarget, value: ParamOrLiteral }).strict(),
  z.object({ kind: z.literal("element_visible"), target: ConditionTarget }).strict(),
  z.object({ kind: z.literal("text_matches"), target: ConditionTarget, pattern: z.string().min(1) }).strict(),
  /** Page-wide text search — no target. Used for outcome detectors that don't anchor to one element. */
  z.object({ kind: z.literal("text_present"), pattern: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("element_count_gt"), target: ConditionTarget, count: z.number().int().nonnegative() }).strict(),
]);

/**
 * A condition is either one leaf check or an `all` composite of several
 * (used by `success.checkpoint`, which typically must satisfy more than
 * one thing at once). Recursive via `z.lazy` since `all` nests Condition.
 */
export type ConditionT =
  | z.infer<typeof LeafCondition>
  | { kind: "all"; of: ConditionT[] };

export const Condition: z.ZodType<ConditionT> = z.lazy(() =>
  z.union([
    LeafCondition,
    z.object({ kind: z.literal("all"), of: z.array(Condition).min(1) }).strict(),
  ]),
);

// ---------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------

export const OnCondition = z
  .object({
    /** Convention: `"detector:<name>"`, matched against a declared detector name. */
    when: z.string().regex(/^detector:/, "on_condition.when must start with 'detector:'"),
    do: z.enum(["escalate", "dismiss_and_retry"]),
    /** Bounded retry count for `dismiss_and_retry` (SPEC.md anti-goal: no retry-everything wrappers). */
    max: z.number().int().positive().optional(),
  })
  .strict();

export const Step = z
  .object({
    id: z.string().min(1),
    intent: z.string().min(1),
    /** Mutating steps flip the failure taxonomy: a failure at/after this step is `failed_dirty` (EDGE-10). */
    mutating: z.boolean(),
    /**
     * Three tiers, matching the brief's own language (3.4): `safe`
     * (read-only or trivially reversible), `risky` (reversible but
     * consequential), `irreversible` (routes to require_approval at
     * the gate regardless of what the caller asked for).
     */
    risk: z.enum(["safe", "risky", "irreversible"]),
    action: Action,
    target: TargetSpec,
    /** Optional: not every action needs an assertion (e.g. a `read`). */
    expect: Condition.optional(),
    on_condition: z.array(OnCondition).default([]),
    timeout_ms: z.number().int().positive().default(5000),
  })
  .strict();
export type StepT = z.infer<typeof Step>;

// ---------------------------------------------------------------------
// Capability metadata, target, inputs, outputs
// ---------------------------------------------------------------------

export const Capability = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "capability.id must be dot-separated lowercase segments"),
    version: z.string().regex(SEMVER, "capability.version must be semver X.Y.Z"),
    name: z.string().min(1),
    description: z.string().min(1),
    /** Gates execution: draft artifacts refuse unattended replay without `--allow-draft`. */
    status: z.enum(["draft", "verified", "approved"]),
    risk_class: z.enum(["read_only", "mutating"]),
  })
  .strict();
export type CapabilityT = z.infer<typeof Capability>;

export const Target = z
  .object({
    app_id: z.string().min(1),
    /** Advisory only — never gates execution, never trusted for a security decision. */
    app_version_hint: z.string().optional(),
    surface: z.enum(["web", "legacy_web", "desktop"]),
    /** Route-canonicalised (EDGE-02) entry path/URL, navigated to implicitly before steps[0]. */
    entry_point: z.string().min(1),
    policy_ref: z.string().min(1),
  })
  .strict();

const IO_TYPES = ["string", "number", "money", "boolean", "date"] as const;

export const InputParam = z
  .object({
    name: z.string().min(1),
    type: z.enum(IO_TYPES),
    required: z.boolean(),
    pattern: z.string().optional(),
    /** Redacted inputs are stored in steps as ParamRef only; the writer refuses a literal match (EDGE-21). */
    redact: z.boolean().default(false),
    example: z.string().optional(),
  })
  .strict();

export const OutputSpec = z
  .object({
    name: z.string().min(1),
    type: z.enum(IO_TYPES),
    required: z.boolean(),
    /** Step id whose `read` action produced this output. */
    from_step: z.string().min(1),
    /** Redacted outputs return real values in-process; logs get `[REDACTED:<type>]` (EDGE-20). */
    redact: z.boolean().default(false),
  })
  .strict();

// ---------------------------------------------------------------------
// Success checkpoint and outcomes
// ---------------------------------------------------------------------

export const Success = z
  .object({
    checkpoint: Condition,
    /** EDGE-12: asserted false at run start, so a stale confirmation banner can't produce a false pass. */
    precondition_false: z.boolean().default(false),
    required_outputs: z.array(z.string()).default([]),
  })
  .strict();

export const Outcome = z
  .object({
    code: z.string().min(1),
    terminal: z.boolean(),
    /** Detectors evaluated low-to-high, before the success checkpoint (EDGE-14). */
    precedence: z.number().int(),
    detector: Condition,
    message: z.string().optional(),
  })
  .strict();
export type OutcomeT = z.infer<typeof Outcome>;

// ---------------------------------------------------------------------
// Overlays — sparse per-tenant patches, merged by step/outcome id
// ---------------------------------------------------------------------

export const StepOverride = z
  .object({
    action: Action.optional(),
    target: TargetSpec.optional(),
    expect: Condition.optional(),
    on_condition: z.array(OnCondition).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();
export type StepOverrideT = z.infer<typeof StepOverride>;

export const OutcomeOverride = z
  .object({
    detector: Condition.optional(),
    message: z.string().optional(),
    terminal: z.boolean().optional(),
    precedence: z.number().int().optional(),
  })
  .strict();
export type OutcomeOverrideT = z.infer<typeof OutcomeOverride>;

const Overlay = z
  .object({
    steps: z.record(z.string(), StepOverride).default({}),
    outcomes: z.record(z.string(), OutcomeOverride).default({}),
  })
  .strict();

/** Keyed by tenant id, e.g. `"tenant_b"`. */
export const Overlays = z.record(z.string(), Overlay);
export type OverlaysT = z.infer<typeof Overlays>;

// ---------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------

export const Provenance = z
  .object({
    discovered_at: z.string().datetime(),
    model: z.string().min(1),
    discovery_run_id: z.string().min(1),
    steps_pruned: z.number().int().nonnegative(),
    /** Set by the mandatory post-discovery verification replay (EDGE-27) before this artifact is ever persisted. */
    verified_replays: z.number().int().nonnegative(),
    last_verified_at: z.string().datetime().optional(),
  })
  .strict();

// ---------------------------------------------------------------------
// Top-level artifact
// ---------------------------------------------------------------------

export const ArtifactSchema = z
  .object({
    schema_version: z.string().regex(SEMVER, "schema_version must be semver X.Y.Z"),
    capability: Capability,
    target: Target,
    inputs: z.array(InputParam).default([]),
    outputs: z.array(OutputSpec).default([]),
    steps: z.array(Step).min(1),
    success: Success,
    outcomes: z.array(Outcome).default([]),
    overlays: Overlays.optional(),
    provenance: Provenance,
  })
  .strict();

export type Artifact = z.infer<typeof ArtifactSchema>;

/**
 * Parse and validate an artifact, returning a readable error path on
 * failure rather than a raw zod exception (P1 acceptance criterion).
 */
export function parseArtifact(data: unknown):
  | { ok: true; artifact: Artifact }
  | { ok: false; errors: string[] } {
  const result = ArtifactSchema.safeParse(data);
  if (result.success) return { ok: true, artifact: result.data };
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  return { ok: false, errors };
}

/**
 * EDGE-21: the artifact writer refuses to persist a literal string
 * matching a redacted input's actual value. Recorders call this before
 * writing; it does not run as part of schema validation itself because
 * it needs the caller's real (unredacted) input values to check against,
 * which are never part of the artifact's own on-disk shape.
 *
 * Scoped to `steps` and `outcomes` only — the parts of the artifact a
 * live recorded run actually populates with captured data. `inputs[].example`
 * is deliberately excluded: it is author-declared documentation (EDGE-01,
 * "the goal spec declares intended input names and example values up
 * front"), not a value captured from a run, and is expected to look like
 * a real value (e.g. `"example": "10001"` on a `redact: true` input) —
 * flagging it would be a false positive on the schema's own worked example.
 */
export function findRedactedLiteralLeaks(
  artifact: Artifact,
  inputValues: Record<string, string>,
): string[] {
  const redactedValues = artifact.inputs
    .filter((i) => i.redact && inputValues[i.name] !== undefined)
    .map((i) => inputValues[i.name] as string)
    .filter((v) => v.length > 0);
  if (redactedValues.length === 0) return [];

  const leaks: string[] = [];
  const serialized = JSON.stringify({ steps: artifact.steps, outcomes: artifact.outcomes });
  for (const value of redactedValues) {
    // A ParamRef substitution ({"$param":"name"}) is fine; a literal
    // occurrence of the raw value anywhere in steps/outcomes is not.
    if (serialized.includes(JSON.stringify(value))) {
      leaks.push(value);
    }
  }
  return leaks;
}
