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
import { handleStuckEscalation } from "../src/discovery/loop.js";

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
