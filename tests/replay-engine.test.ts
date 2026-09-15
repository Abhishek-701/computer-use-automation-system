/**
 * P4 acceptance criterion (SPEC.md Section 5): the hand-written P1
 * artifact replays green against the live target app. Replaying it
 * with a not-found input returns `business_outcome`, not `failed`.
 *
 * Boots the real target app on an ephemeral port (same pattern as
 * tests/surface-adapter.test.ts) and runs the actual replay engine
 * against it with a real headless Chromium — no mocking of the engine
 * itself, only the policy is loaded fresh per test so origin checks
 * match the ephemeral port.
 */
import type { Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTargetApp } from "../target-app/app.js";
import { replay, mergeOverlay } from "../src/replay/engine.js";
import { ArtifactSchema, type Artifact, type StepT } from "../src/schema/artifact.js";
import { loadPolicy, type PolicyT } from "../src/policy/gate.js";
import { PlaywrightWebAdapter } from "../src/surface/web.playwright.js";
import { isStuckCondition } from "../src/escalation/session.js";

const createAdapter = (url: string) => PlaywrightWebAdapter.create(url, { headless: true });

let server: Server;
let baseUrl: string;
let policy: PolicyT;
let artifact: Artifact;

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://localhost:${address.port}`;

  const rawPolicy = JSON.parse(readFileSync(new URL("../src/policy/policy.default.json", import.meta.url), "utf-8"));
  policy = loadPolicy({ ...rawPolicy, allowed_origins: [baseUrl] });

  // Fixed fixture, not the live artifacts/ path: SPEC.md's P4 acceptance
  // criterion is specifically about "the hand-written P1 artifact"
  // replaying green — and CP6's discovery run legitimately overwrites
  // the live capability artifact with a real discovered one afterward.
  const rawArtifact = JSON.parse(readFileSync(new URL("./fixtures/hand-written-member-lookup.json", import.meta.url), "utf-8"));
  artifact = ArtifactSchema.parse(rawArtifact);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("replay engine (P4 acceptance)", () => {
  it("replays green: success with typed outputs", async () => {
    const result = await replay({ artifact, inputs: { member_id: "10001" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("success");
    expect(result.outputs["savings_balance"]).toBe("$4,231.10");
    expect(result.warnings?.locator_drift ?? []).toEqual([]);
  }, 20_000);

  it("returns business_outcome, not failed, for a not-found input", async () => {
    const result = await replay({ artifact, inputs: { member_id: "99999" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("business_outcome");
    expect(result.outcome?.code).toBe("member_not_found");
    expect(result.outcome?.detected_at_step).toBe("submit_search");
  }, 20_000);

  it("classifies permission_denied as a business outcome", async () => {
    const result = await replay({ artifact, inputs: { member_id: "55555" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("business_outcome");
    expect(result.outcome?.code).toBe("permission_denied");
  }, 20_000);

  it("classifies multiple_matches as a business outcome", async () => {
    const result = await replay({ artifact, inputs: { member_id: "10002" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("business_outcome");
    expect(result.outcome?.code).toBe("multiple_matches");
  }, 20_000);

  it("classifies validation_error as a business outcome for malformed input", async () => {
    const result = await replay({ artifact, inputs: { member_id: "" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("business_outcome");
    expect(result.outcome?.code).toBe("validation_error");
  }, 20_000);

  it("recovers from a seeded interstitial via dismiss_and_retry and still succeeds", async () => {
    // The interstitial flag isn't part of the artifact's inputs, so we
    // seed it by overriding the entry point's query string directly.
    const withInterstitialEntry: Artifact = {
      ...artifact,
      target: { ...artifact.target, entry_point: "/members/search?interstitial=1" },
    };
    const result = await replay({ artifact: withInterstitialEntry, inputs: { member_id: "10001" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("success");
    expect(result.warnings?.recovered_conditions).toEqual([{ step_id: "enter_member_id", condition: "known_interstitial", attempts: 1 }]);
  }, 20_000);

  it("P6/SPEC.md §7: a hard failure captures a screenshot and references it as failure.evidence_ref", async () => {
    const badArtifact: Artifact = {
      ...artifact,
      steps: [
        {
          id: "impossible_click",
          intent: "Click something that doesn't exist, to force a resolve failure",
          mutating: false,
          risk: "safe",
          action: { type: "click" },
          target: { primary: { by: "role_name", role: "button", name: "Does Not Exist" }, fallbacks: [] },
          on_condition: [],
          timeout_ms: 1000,
        },
      ],
    };
    const evidenceDir = mkdtempSync(join(tmpdir(), "replay-evidence-test-"));
    const result = await replay({ artifact: badArtifact, inputs: {}, baseUrl, policy, createAdapter, allowDraft: true, evidenceDir });
    expect(result.status).toBe("failed");
    expect(result.failure?.evidence_ref).toBeTruthy();
    expect(result.evidence.screenshots).toEqual([result.failure?.evidence_ref]);
    expect(readFileSync(result.failure!.evidence_ref!).length).toBeGreaterThan(0);
  }, 20_000);

  it("EDGE-10: reports failed_dirty, not failed, once past a mutating step", async () => {
    // Build a tiny artifact isolating the failed/failed_dirty split
    // specifically: step 1 selects the account type (marked `mutating`
    // for this test even though selecting isn't really irreversible —
    // deliberately NOT the real "Confirm" button, which the default
    // policy's irreversible_actions rule matches regardless of a step's
    // own risk label; that interaction is policy-gate.test.ts's concern,
    // not this one). Step 2 targets a button that can never resolve.
    const mutatingArtifact: Artifact = {
      ...artifact,
      target: { ...artifact.target, entry_point: "/members/10001/subaccount/new" },
      steps: [
        {
          id: "select_type",
          intent: "Select the sub-account type",
          mutating: true,
          risk: "safe",
          action: { type: "select", value: "savings" },
          target: { primary: { by: "role_name", role: "combobox", name: "Account type" }, fallbacks: [] },
          on_condition: [],
          timeout_ms: 5000,
        },
        {
          id: "impossible_followup",
          intent: "A step whose target can never resolve, to force a post-mutation failure",
          mutating: false,
          risk: "safe",
          action: { type: "click" },
          target: { primary: { by: "role_name", role: "button", name: "Nonexistent Button" }, fallbacks: [] },
          on_condition: [],
          timeout_ms: 1000,
        },
      ],
      capability: { ...artifact.capability, risk_class: "mutating" },
    };
    const result = await replay({ artifact: mutatingArtifact, inputs: {}, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("failed_dirty");
    expect(result.failure?.step_id).toBe("impossible_followup");
  }, 20_000);

  it("tolerates transient slowness (?slow=1500) — polling absorbs it, replay still succeeds", async () => {
    // "Zero wall-clock waits" (REPORT.md §3): waitForCondition/locate poll
    // until the condition holds or timeout_ms elapses, so an app that's
    // merely slow — not broken — must not fail a replay whose per-step
    // timeouts (5000-10000ms here) comfortably exceed the injected delay.
    const slowEntry: Artifact = { ...artifact, target: { ...artifact.target, entry_point: "/members/search?slow=1500" } };
    const result = await replay({ artifact: slowEntry, inputs: { member_id: "10001" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("success");
    expect(result.outputs["savings_balance"]).toBe("$4,231.10");
  }, 20_000);

  it("classifies a seeded server error (?boom=1) as a plain hard failure, not a crash or a business outcome", async () => {
    // The content route throws synchronously (target-app/routes.ts's
    // applyGenericFlags); the resulting 500 page has no search form at
    // all, so the very first step can't resolve its target — the same
    // shape as evidence/replay-outcomes/boom/result.json.
    const boomEntry: Artifact = { ...artifact, target: { ...artifact.target, entry_point: "/members/search?boom=1" } };
    const result = await replay({ artifact: boomEntry, inputs: { member_id: "10001" }, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("failed");
    expect(result.failure?.error_class).toBe("target_not_found");
    expect(result.failure?.step_id).toBe("enter_member_id");
    expect(isStuckCondition(result.failure!.error_class)).toBe(false); // an app error is a hard failure, not a human's problem
  }, 20_000);

  it("detects session/timeout expiry (?expire=1) as a stuck-shaped failure, escalation-eligible", async () => {
    // `expire` only takes effect on the subaccount route (target-app's
    // seeded condition for this case), returning a page whose text
    // matches policy.default.json's `session_expired` known_detector.
    // Declaring it with `do: "escalate"` is what makes this a candidate
    // for src/escalation/session.ts's runReplayWithEscalation (proven
    // end-to-end for a different trigger in tests/escalation.test.ts) —
    // this test's job is just to prove *this specific seeded condition*
    // is detected and classified as stuck, not to re-run the full handoff.
    const expireStep: StepT = {
      id: "select_type",
      intent: "Select the sub-account type",
      mutating: false,
      risk: "safe",
      action: { type: "select", value: "savings" },
      target: { primary: { by: "role_name", role: "combobox", name: "Account type" }, fallbacks: [] },
      on_condition: [{ when: "detector:session_expired", do: "escalate" }],
      timeout_ms: 5000,
    };
    const expireArtifact: Artifact = {
      ...artifact,
      target: { ...artifact.target, entry_point: "/members/10001/subaccount/new?expire=1" },
      steps: [expireStep],
    };
    const result = await replay({ artifact: expireArtifact, inputs: {}, baseUrl, policy, createAdapter, allowDraft: true });
    expect(result.status).toBe("failed");
    expect(result.failure?.error_class).toBe("detector_session_expired");
    expect(isStuckCondition(result.failure!.error_class)).toBe(true);
  }, 20_000);
});

describe("mergeOverlay (pure, no browser)", () => {
  it("returns the base artifact unchanged when no overlay exists for the tenant", () => {
    const merged = mergeOverlay(artifact, "tenant_z");
    expect(merged).toEqual(artifact);
  });

  it("throws loudly when an overlay references an unknown step id", () => {
    const withBadOverlay: Artifact = {
      ...artifact,
      overlays: { tenant_b: { steps: { nonexistent_step: { timeout_ms: 9999 } }, outcomes: {} } },
    };
    expect(() => mergeOverlay(withBadOverlay, "tenant_b")).toThrow(/unknown step id/);
  });

  it("throws loudly when an overlay references an unknown outcome code", () => {
    const withBadOverlay: Artifact = {
      ...artifact,
      overlays: { tenant_b: { steps: {}, outcomes: { nonexistent_code: { message: "x" } } } },
    };
    expect(() => mergeOverlay(withBadOverlay, "tenant_b")).toThrow(/unknown outcome code/);
  });

  it("produces a schema-valid, merged artifact for a valid overlay", () => {
    const withOverlay: Artifact = {
      ...artifact,
      overlays: {
        tenant_b: {
          steps: { enter_member_id: { target: { primary: { by: "role_name", role: "textbox", name: "Member Number" }, fallbacks: [] } } },
          outcomes: { member_not_found: { message: "No records found." } },
        },
      },
    };
    const merged = mergeOverlay(withOverlay, "tenant_b");
    expect(merged.steps.find((s) => s.id === "enter_member_id")?.target.primary).toEqual({
      by: "role_name",
      role: "textbox",
      name: "Member Number",
    });
    expect(merged.outcomes.find((o) => o.code === "member_not_found")?.message).toBe("No records found.");
    // Untouched steps/outcomes pass through unchanged.
    expect(merged.steps.find((s) => s.id === "submit_search")).toEqual(artifact.steps.find((s) => s.id === "submit_search"));
  });
});
