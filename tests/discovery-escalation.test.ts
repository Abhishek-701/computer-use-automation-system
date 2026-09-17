/**
 * Discovery-side escalation (SPEC.md §3.6's first trigger: "the agent is
 * stuck during discovery"), previously wired only for replay. Tests
 * `handleStuckEscalation` directly against a real live target app +
 * real Playwright adapter — same "no mocking the engine" convention as
 * tests/escalation.test.ts — rather than the full `discover()` loop,
 * which constructs a real Anthropic client unconditionally; `npm test`
 * must not need an API key (README), so the escalation logic is
 * exercised in isolation from the model-calling loop around it.
 */
import type { Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTargetApp } from "../target-app/app.js";
import { PlaywrightWebAdapter } from "../src/surface/web.playwright.js";
import { EscalationSession, type InterventionRequest } from "../src/escalation/session.js";
import { handleStuckEscalation, handleApprovalEscalation, settledObserve } from "../src/discovery/loop.js";
import { locate } from "../src/replay/locator.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createTargetApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("handleStuckEscalation (discovery-side, live target app)", () => {
  it("raises a well-formed intervention, waits for a human on the SAME live adapter, and resumes with a fresh observation", async () => {
    const entryUrl = new URL("/members/search", baseUrl).toString();
    const adapter = await PlaywrightWebAdapter.create(entryUrl, { headless: true });
    const session = new EscalationSession();
    const evidenceDir = mkdtempSync(join(tmpdir(), "discovery-escalation-test-"));

    let captured: InterventionRequest | undefined;

    const resultPromise = handleStuckEscalation({
      adapter,
      escalation: { session, evidenceDir, interventionTimeoutMs: 30_000, onIntervention: (request) => (captured = request) },
      capabilityId: "member.savings_balance.lookup",
      goal: "Look up a member's savings balance",
      runId: "test_run",
      stepIndex: 3,
      reason: "the page shows an element I don't recognize and no supported action applies",
      attempt: 1,
    });

    await vi.waitFor(() => expect(session.getState()).toBe("human"), { timeout: 5000, interval: 50 });

    expect(captured).toBeDefined();
    expect(captured).toMatchObject({
      capability_id: "member.savings_balance.lookup",
      current_step_id: "discovery_step_3",
      reason_code: "discovery_stuck",
    });
    expect(captured!.observation.nodes.length).toBeGreaterThan(0);
    expect(captured!.screenshot_path).toBeTruthy();
    expect(readFileSync(captured!.screenshot_path!).length).toBeGreaterThan(0);

    // The "human": navigate the SAME live adapter somewhere else entirely,
    // proving the resumed observation reflects what the human left behind,
    // not a stale snapshot from before the handoff.
    await adapter.act({ type: "navigate", url: "/members/10001" });
    const resumeResult = session.resume(captured!.resume_token);
    expect(resumeResult).toEqual({ ok: true });

    const result = await resultPromise;
    expect(result.outcome).toBe("resumed");
    if (result.outcome === "resumed") {
      expect(result.observation.url).toContain("/members/10001");
    }
    expect(session.getState()).toBe("automation"); // cycle complete
    expect(readFileSync(join(evidenceDir, "handoff-1", "after.png")).length).toBeGreaterThan(0);

    await adapter.close();
  }, 30_000);

  it("EDGE-22: an abandoned intervention (timeout, no human) reports 'abandoned', not a hang", async () => {
    const entryUrl = new URL("/members/search", baseUrl).toString();
    const adapter = await PlaywrightWebAdapter.create(entryUrl, { headless: true });
    const session = new EscalationSession();
    const evidenceDir = mkdtempSync(join(tmpdir(), "discovery-escalation-test-"));

    const resultPromise = handleStuckEscalation({
      adapter,
      escalation: { session, evidenceDir, interventionTimeoutMs: 200 },
      capabilityId: "member.savings_balance.lookup",
      goal: "Look up a member's savings balance",
      runId: "test_run",
      stepIndex: 1,
      reason: "stuck",
      attempt: 1,
    });

    const result = await resultPromise;
    expect(result.outcome).toBe("abandoned");
    expect(session.getState()).toBe("abandoned");

    await adapter.close();
  }, 10_000);
});

describe("handleApprovalEscalation (discovery-side, live target app)", () => {
  it("raises a requires_approval intervention, and approval lets the caller proceed without altering the page itself", async () => {
    const entryUrl = new URL("/members/10001/subaccount/new", baseUrl).toString();
    const adapter = await PlaywrightWebAdapter.create(entryUrl, { headless: true });
    const session = new EscalationSession();
    const evidenceDir = mkdtempSync(join(tmpdir(), "discovery-approval-test-"));

    let captured: InterventionRequest | undefined;

    const resultPromise = handleApprovalEscalation({
      adapter,
      escalation: { session, evidenceDir, interventionTimeoutMs: 30_000, onIntervention: (request) => (captured = request) },
      capabilityId: "member.subaccount.open",
      goal: "Open a new sub-account for member 10001",
      runId: "test_run",
      stepIndex: 4,
      actionDescription: 'click on button named "Confirm"',
      attempt: 1,
    });

    await vi.waitFor(() => expect(session.getState()).toBe("human"), { timeout: 5000, interval: 50 });

    expect(captured).toBeDefined();
    expect(captured).toMatchObject({
      capability_id: "member.subaccount.open",
      current_step_id: "discovery_step_4",
      reason_code: "requires_approval",
    });
    expect(captured!.reason).toContain('click on button named "Confirm"');
    expect(captured!.screenshot_path).toBeTruthy();
    expect(readFileSync(captured!.screenshot_path!).length).toBeGreaterThan(0);

    const urlBeforeApproval = (await adapter.observe()).url;
    const resumeResult = session.resume(captured!.resume_token);
    expect(resumeResult).toEqual({ ok: true });

    const result = await resultPromise;
    expect(result.approved).toBe(true);
    expect(session.getState()).toBe("automation"); // cycle complete

    // Approval itself performs no action — the page is unchanged; the
    // caller (discover()'s loop) is responsible for the actual click.
    const urlAfterApproval = (await adapter.observe()).url;
    expect(urlAfterApproval).toBe(urlBeforeApproval);

    await adapter.close();
  }, 30_000);

  it("EDGE-22: an abandoned approval request reports approved:false, not a hang", async () => {
    const entryUrl = new URL("/members/10001/subaccount/new", baseUrl).toString();
    const adapter = await PlaywrightWebAdapter.create(entryUrl, { headless: true });
    const session = new EscalationSession();
    const evidenceDir = mkdtempSync(join(tmpdir(), "discovery-approval-test-"));

    const result = await handleApprovalEscalation({
      adapter,
      escalation: { session, evidenceDir, interventionTimeoutMs: 200 },
      capabilityId: "member.subaccount.open",
      goal: "Open a new sub-account for member 10001",
      runId: "test_run",
      stepIndex: 4,
      actionDescription: 'click on button named "Confirm"',
      attempt: 1,
    });

    expect(result.approved).toBe(false);
    expect(session.getState()).toBe("abandoned");

    await adapter.close();
  }, 10_000);
});

describe("settledObserve (regression: found live while building member.subaccount.open)", () => {
  it("returns the post-navigation page after a click that submits a form, not a mid-transition snapshot", async () => {
    // The exact scenario that derailed a real discovery run: SurfaceAdapter's
    // click has no built-in wait for the navigation it triggers (a form
    // submit reloading the nested content iframe). A single immediate
    // observe() intermittently caught the pre-navigation DOM; discover()'s
    // loop previously took exactly one such observation per turn, no
    // polling, unlike replay's waitForCondition. This asserts the fix's
    // contract directly: whatever a bare observe() might race, settledObserve
    // reliably lands on the settled result.
    // Reached via direct top-level navigation, not via a click chain
    // starting at /members/search, so — unlike the artifact's own
    // steps — this page is not nested inside the shell/content iframe;
    // no scope needed (same as the requires_approval test above).
    const adapter = await PlaywrightWebAdapter.create(new URL("/members/10001/subaccount/new", baseUrl).toString(), { headless: true });

    await locate(adapter, { primary: { by: "role_name", role: "combobox", name: "Account type" }, fallbacks: [] }, 3000);
    await adapter.act({ type: "select", value: "savings" });
    await locate(adapter, { primary: { by: "role_name", role: "textbox", name: "Initial deposit" }, fallbacks: [] }, 3000);
    await adapter.act({ type: "type", value: "500" });
    await locate(adapter, { primary: { by: "role_name", role: "button", name: "Confirm" }, fallbacks: [] }, 3000);
    await adapter.act({ type: "click" });

    const observation = await settledObserve(adapter);
    expect(observation.nodes.some((n) => n.role === "heading" && n.name === "Sub-account opened")).toBe(true);
    expect(observation.nodes.some((n) => n.role === "textbox" && n.name === "Account number" && /^SA-\d{5}-\d{4}$/.test(n.value ?? ""))).toBe(true);

    await adapter.close();
  }, 15_000);
});
