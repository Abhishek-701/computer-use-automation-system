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
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTargetApp } from "../target-app/app.js";
import { replay, mergeOverlay } from "../src/replay/engine.js";
import { ArtifactSchema, type Artifact } from "../src/schema/artifact.js";
import { loadPolicy, type PolicyT } from "../src/policy/gate.js";
import { PlaywrightWebAdapter } from "../src/surface/web.playwright.js";

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

  const rawArtifact = JSON.parse(readFileSync(new URL("../artifacts/member.savings_balance.lookup.json", import.meta.url), "utf-8"));
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
