/**
 * P6 acceptance criterion (SPEC.md Section 5): a run that trips the
 * stuck detector raises an intervention request containing capability
 * id, step id, reason code, observation and screenshot; a human can
 * drive the same browser window and signal resume; the run re-anchors
 * and completes.
 *
 * Two escalation scenarios against the real target app + a real
 * adapter, matching engine.ts's two re-anchor outcomes (EDGE-24):
 *   - "skip ahead": the human finishes the task themselves; the
 *     checkpoint already holds on resume, so the run completes
 *     immediately without retrying the stuck step.
 *   - "continue": the human clears whatever was blocking the stuck
 *     step (here, an ambiguous target) without finishing the whole
 *     task; the run retries that exact step and proceeds from there.
 * The target app has no natural multi-hop path onward from either
 * fixed page, so the "continue" case is asserted by its distinguishing
 * fact — resolution stops failing as "ambiguous_locator" once resumed
 * — not by a full downstream success, which would require inventing
 * pages the app doesn't have.
 */
import type { Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTargetApp } from "../target-app/app.js";
import { PlaywrightWebAdapter } from "../src/surface/web.playwright.js";
import { loadPolicy, type PolicyT } from "../src/policy/gate.js";
import { EscalationSession, runReplayWithEscalation, isStuckCondition } from "../src/escalation/session.js";
import type { Artifact } from "../src/schema/artifact.js";

let server: Server;
let baseUrl: string;
let policy: PolicyT;

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://localhost:${address.port}`;
  const rawPolicy = JSON.parse(readFileSync(new URL("../src/policy/policy.default.json", import.meta.url), "utf-8"));
  policy = loadPolicy({ ...rawPolicy, allowed_origins: [baseUrl] });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ambiguousHeadingArtifact(): Artifact {
  return {
    schema_version: "1.0.0",
    capability: {
      id: "test.ambiguous_heading",
      version: "1.0.0",
      name: "Test: ambiguous heading click",
      description: "Deliberately contrived, for exercising the escalation mechanism.",
      status: "draft",
      risk_class: "read_only",
    },
    target: { app_id: "target-app-hostile-core-banking", surface: "web", entry_point: "/members/10001", policy_ref: "src/policy/policy.default.json" },
    inputs: [],
    outputs: [],
    steps: [
      {
        id: "click_heading",
        intent: "Click a heading (contrived — the detail page has two, so this is ambiguous by construction)",
        mutating: false,
        risk: "safe",
        action: { type: "click" },
        target: { primary: { by: "role_name", role: "heading" }, fallbacks: [] },
        on_condition: [],
        timeout_ms: 3000,
      },
    ],
    success: {
      checkpoint: { kind: "element_visible", target: { by: "role_name", role: "heading", name: "Open sub-account" } },
      precondition_false: false,
      required_outputs: [],
    },
    outcomes: [],
    provenance: { discovered_at: new Date().toISOString(), model: "test", discovery_run_id: "test", steps_pruned: 0, verified_replays: 0 },
  };
}

describe("EscalationSession state machine (pure)", () => {
  it("raises automation -> human, and rejects a resume while still in automation (EDGE-23)", () => {
    const session = new EscalationSession();
    expect(session.getState()).toBe("automation");
    const rejected = session.resume("whatever");
    expect(rejected).toEqual({ ok: false, reason: "session is not awaiting a human; resume rejected" });
  });

  it("guards resume with the correct token, and rejects a wrong one", () => {
    const session = new EscalationSession();
    const observation = { url: "http://x", nodes: [] };
    session.raise(
      { capability_id: "c", capability_version: "1.0.0", goal: "g", current_step_id: "s", reason_code: "r", reason: "r", observation, session_id: session.sessionId, resume_token: "tok123", raised_at: new Date().toISOString(), timeout_ms: 60_000 },
      { observation },
    );
    expect(session.getState()).toBe("human");
    expect(session.resume("wrong-token")).toEqual({ ok: false, reason: "invalid resume token" });
    expect(session.getState()).toBe("human");
    expect(session.resume("tok123")).toEqual({ ok: true });
    expect(session.getState()).toBe("pending_resume");
  });

  it("rejects a second resume once already pending_resume", () => {
    const session = new EscalationSession();
    const observation = { url: "http://x", nodes: [] };
    session.raise(
      { capability_id: "c", capability_version: "1.0.0", goal: "g", current_step_id: "s", reason_code: "r", reason: "r", observation, session_id: session.sessionId, resume_token: "tok", raised_at: new Date().toISOString(), timeout_ms: 60_000 },
      { observation },
    );
    session.resume("tok");
    expect(session.resume("tok")).toEqual({ ok: false, reason: "resume already signalled" });
  });

  it("EDGE-22: abandons on timeout and rejects a late resume", async () => {
    vi.useFakeTimers();
    const session = new EscalationSession();
    const observation = { url: "http://x", nodes: [] };
    session.raise(
      { capability_id: "c", capability_version: "1.0.0", goal: "g", current_step_id: "s", reason_code: "r", reason: "r", observation, session_id: session.sessionId, resume_token: "tok", raised_at: new Date().toISOString(), timeout_ms: 1000 },
      { observation },
    );
    vi.advanceTimersByTime(1001);
    expect(session.getState()).toBe("abandoned");
    expect(session.resume("tok")).toEqual({ ok: false, reason: "session already abandoned" });
    vi.useRealTimers();
  });

  it("isStuckCondition matches SPEC.md Section 9's trigger list, not every failure class", () => {
    expect(isStuckCondition("ambiguous_locator")).toBe(true);
    expect(isStuckCondition("requires_approval")).toBe(true);
    expect(isStuckCondition("not_interactable_hidden")).toBe(true);
    expect(isStuckCondition("detector_session_expired")).toBe(true);
    expect(isStuckCondition("unrecovered_known_interstitial")).toBe(true);
    expect(isStuckCondition("checkpoint_not_satisfied")).toBe(true);
    expect(isStuckCondition("max_duration_exceeded")).toBe(true);
    expect(isStuckCondition("target_not_found")).toBe(false);
    expect(isStuckCondition("expect_failed")).toBe(false);
  });
});

describe("runReplayWithEscalation (P6 acceptance, live target app)", () => {
  it("raises a well-formed intervention, then resumes and completes via the skip-ahead re-anchor path", async () => {
    const artifact = ambiguousHeadingArtifact();
    const entryUrl = new URL(artifact.target.entry_point, baseUrl).toString();
    const adapter = await PlaywrightWebAdapter.create(entryUrl, { headless: true });
    const session = new EscalationSession();
    const evidenceDir = mkdtempSync(join(tmpdir(), "escalation-test-"));

    let capturedRequest: Parameters<NonNullable<Parameters<typeof runReplayWithEscalation>[0]["onIntervention"]>>[0] | undefined;

    const runPromise = runReplayWithEscalation(
      {
        artifact,
        inputs: {},
        baseUrl,
        policy,
        allowDraft: true,
        createAdapter: async () => adapter,
        session,
        evidenceDir,
        interventionTimeoutMs: 30_000,
        onIntervention: (request) => {
          capturedRequest = request;
        },
      },
      adapter,
    );

    // Wait for the intervention to be raised before acting as the "human".
    await vi.waitFor(() => expect(session.getState()).toBe("human"), { timeout: 5000, interval: 50 });

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest).toMatchObject({
      capability_id: "test.ambiguous_heading",
      capability_version: "1.0.0",
      current_step_id: "click_heading",
      reason_code: "ambiguous_locator",
    });
    expect(capturedRequest!.observation.nodes.length).toBeGreaterThan(0);
    expect(capturedRequest!.screenshot_path).toBeTruthy();
    expect(readFileSync(capturedRequest!.screenshot_path!).length).toBeGreaterThan(0); // a real, non-empty PNG was written

    // The "human": drive the SAME live adapter directly to a page that
    // already satisfies the checkpoint — finishing the task by hand.
    // (The subaccount form is reachable by direct navigation and has
    // exactly one heading, unlike the detail page's two.)
    const navResult = await adapter.act({ type: "navigate", url: "/members/10001/subaccount/new" });
    expect(navResult).toEqual({ ok: true });

    const resumeResult = session.resume(capturedRequest!.resume_token);
    expect(resumeResult).toEqual({ ok: true });

    const finalResult = await runPromise;
    expect(finalResult.status).toBe("success");
    expect(finalResult.control_transfers).toHaveLength(1);
    expect(finalResult.control_transfers[0]).toMatchObject({ at_step: "click_heading", reason: "ambiguous_locator" });
    expect(session.getState()).toBe("automation"); // cycle complete
  }, 30_000);

  it("continue path: resuming clears the ambiguity without finishing the task — the retried step resolves, even though this contrived flow has nowhere further to go", async () => {
    const artifact = ambiguousHeadingArtifact();
    // Checkpoint that's reachable from neither fixed page, so re-anchoring
    // takes the "continue" branch (not skip-ahead) — distinguishing fact
    // asserted below is that resolution stops failing as ambiguous.
    artifact.success.checkpoint = { kind: "element_visible", target: { by: "role_name", role: "heading", name: "Nothing Named This" } };

    const entryUrl = new URL(artifact.target.entry_point, baseUrl).toString();
    const adapter = await PlaywrightWebAdapter.create(entryUrl, { headless: true });
    const session = new EscalationSession();
    const evidenceDir = mkdtempSync(join(tmpdir(), "escalation-test-"));

    const runPromise = runReplayWithEscalation(
      { artifact, inputs: {}, baseUrl, policy, allowDraft: true, createAdapter: async () => adapter, session, evidenceDir, interventionTimeoutMs: 30_000 },
      adapter,
    );

    await vi.waitFor(() => expect(session.getState()).toBe("human"), { timeout: 5000, interval: 50 });
    const request = session.getRequest()!;

    // Human clears the ambiguity: navigate to a page with exactly one
    // heading (role_name role=heading with no name now resolves), but
    // one that doesn't satisfy this test's checkpoint.
    await adapter.act({ type: "navigate", url: "/members/10001/subaccount/new" });
    session.resume(request.resume_token);

    const finalResult = await runPromise;
    // The contrived flow has nowhere further to go from the subaccount
    // form, so this doesn't reach success — but critically, it fails with
    // checkpoint_not_satisfied, NOT ambiguous_locator: proof the retried
    // step actually resolved and executed, i.e. the "continue" branch ran.
    expect(finalResult.status).toBe("failed");
    expect(finalResult.failure?.error_class).toBe("checkpoint_not_satisfied");
    expect(finalResult.control_transfers).toHaveLength(1);
  }, 30_000);
});
