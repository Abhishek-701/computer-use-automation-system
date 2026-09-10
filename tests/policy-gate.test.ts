/**
 * P3 acceptance criterion (SPEC.md Section 5): a test proves a
 * navigation to a disallowed origin is blocked; a test proves an
 * action marked irreversible returns require_approval. Also covers
 * EDGE-19 (allowlist matching after URL normalisation) and EDGE-08
 * (passive-navigation checking), both [test]-tagged in SPEC.md Section 11.
 */
import { describe, expect, it } from "vitest";
import { checkOriginAndRoute, enforce, loadPolicy, type PolicyT } from "../src/policy/gate.js";
import type { StepT } from "../src/schema/artifact.js";

const policy: PolicyT = loadPolicy({
  allowed_origins: ["http://localhost:3000"],
  allowed_routes: ["/", "/members/**"],
  allowed_action_types: {
    discovery: ["navigate", "click", "type", "select", "read"],
    replay: ["navigate", "click", "type", "select", "read"],
  },
  irreversible_actions: [{ action_type: "click", role: "button", name_pattern: "^Confirm$" }],
  redaction_patterns: [],
  max_steps: 40,
  max_duration_ms: 120_000,
});

function confirmStep(risk: StepT["risk"]): StepT {
  return {
    id: "confirm_subaccount",
    intent: "Confirm opening the sub-account",
    mutating: true,
    risk,
    action: { type: "click" },
    target: {
      fallbacks: [],
      primary: { by: "role_name", role: "button", name: "Confirm" },
    },
    on_condition: [],
    timeout_ms: 5000,
  };
}

describe("policy gate: allowlist (P3 acceptance + EDGE-19 + EDGE-08)", () => {
  it("blocks navigation to a disallowed origin", () => {
    const result = enforce(
      { type: "navigate", url: "http://evil.example.com/phish" },
      { url: "http://localhost:3000/members/search", mode: "replay" },
      policy,
    );
    expect(result.decision).toBe("block");
  });

  it("allows navigation within the allowlisted origin and route", () => {
    const result = enforce(
      { type: "navigate", url: "http://localhost:3000/members/10001" },
      { url: "http://localhost:3000/members/search", mode: "replay" },
      policy,
    );
    expect(result).toEqual({ decision: "allow" });
  });

  it("EDGE-19: blocks a dot-segment traversal that resolves outside the allowlist", () => {
    const result = enforce(
      { type: "navigate", url: "http://localhost:3000/members/../admin" },
      { url: "http://localhost:3000/members/search", mode: "replay" },
      policy,
    );
    expect(result.decision).toBe("block");
    // Prove it's actually being checked as the normalised /admin, not the literal string.
    if (result.decision === "block") {
      expect(result.reason).toContain("/admin");
      expect(result.reason).not.toContain("..");
    }
  });

  it("EDGE-08: passive navigation is checked directly against the allowlist, independent of any action", () => {
    // Simulates the replay/discovery loop calling this after every observe(),
    // for a redirect that was never an emitted action (meta-refresh, SSO bounce).
    const insideAllowlist = checkOriginAndRoute("http://localhost:3000/members/10001", policy);
    expect(insideAllowlist).toEqual({ decision: "allow" });

    const outsideAllowlist = checkOriginAndRoute("http://localhost:3000/admin/reset", policy);
    expect(outsideAllowlist.decision).toBe("block");
  });

  it("blocks an action type not permitted in the current mode", () => {
    const restrictive = loadPolicy({
      ...policy,
      allowed_action_types: { discovery: [], replay: ["navigate", "click", "type", "select", "read"] },
    });
    const result = enforce(
      { type: "click" },
      { url: "http://localhost:3000/members/search", mode: "discovery", step: confirmStep("safe") },
      restrictive,
    );
    expect(result.decision).toBe("block");
  });
});

describe("policy gate: irreversibility (P3 acceptance)", () => {
  it("returns require_approval for a step marked irreversible in replay mode", () => {
    const result = enforce(
      { type: "click" },
      { url: "http://localhost:3000/members/10001/subaccount/new", mode: "replay", step: confirmStep("irreversible") },
      policy,
    );
    expect(result.decision).toBe("require_approval");
  });

  it("still returns require_approval via the policy rule even when a replay step under-claims risk:safe (defense in depth)", () => {
    const result = enforce(
      { type: "click" },
      { url: "http://localhost:3000/members/10001/subaccount/new", mode: "replay", step: confirmStep("safe") },
      policy,
    );
    expect(result.decision).toBe("require_approval");
  });

  it("discovery mode never trusts a self-declared risk label — the policy rule is what decides, regardless of what the model claims", () => {
    // Discovery mode ignores step.risk entirely (see classifyIrreversible);
    // only the independent policy-rule match against the target can escalate.
    const result = enforce(
      { type: "click" },
      { url: "http://localhost:3000/members/10001/subaccount/new", mode: "discovery", step: confirmStep("irreversible") },
      policy,
    );
    expect(result.decision).toBe("require_approval");
  });

  it("allows an ordinary click that matches no irreversible rule", () => {
    const searchClick: StepT = { ...confirmStep("safe"), target: { fallbacks: [], primary: { by: "role_name", role: "button", name: "Search" } } };
    const result = enforce(
      { type: "click" },
      { url: "http://localhost:3000/members/search", mode: "replay", step: searchClick },
      policy,
    );
    expect(result).toEqual({ decision: "allow" });
  });
});

describe("policy loader", () => {
  it("loads the real policy.default.json without error", async () => {
    const raw = await import("../src/policy/policy.default.json", { with: { type: "json" } });
    expect(() => loadPolicy(raw.default)).not.toThrow();
  });

  it("rejects a malformed policy with a readable zod error", () => {
    expect(() => loadPolicy({ allowed_origins: "not-an-array" })).toThrow();
  });
});
