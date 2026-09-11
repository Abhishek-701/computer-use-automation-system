/**
 * The intervention endpoint + mock operator page (SPEC.md Section 9,
 * P6): "a small HTTP server exposing the request and a resume
 * endpoint, plus a bare HTML operator page."
 */
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEscalationServer } from "../src/escalation/server.js";
import { EscalationSession } from "../src/escalation/session.js";
import type { Observation } from "../src/surface/adapter.js";

let server: Server;
let baseUrl: string;
let session: EscalationSession;
let screenshotsDir: string;

const observation: Observation = { url: "http://x/members/10001", nodes: [{ role: "heading", name: "Account summary", state: { visible: true }, framePath: [], handle: "h1" }] };

beforeAll(async () => {
  session = new EscalationSession();
  screenshotsDir = mkdtempSync(join(tmpdir(), "escalation-server-test-"));
  writeFileSync(join(screenshotsDir, "before.png"), Buffer.from([137, 80, 78, 71])); // fake PNG bytes, just needs to exist

  const app = createEscalationServer(session, screenshotsDir);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("escalation HTTP server", () => {
  it("GET /intervention returns 404 with no active intervention", async () => {
    const res = await fetch(`${baseUrl}/intervention`);
    expect(res.status).toBe(404);
  });

  it("GET /operator renders a bare page saying nothing is stuck, with no active intervention", async () => {
    const res = await fetch(`${baseUrl}/operator`);
    const html = await res.text();
    expect(html).toContain("No active intervention");
  });

  it("once raised: GET /intervention exposes the request, GET /operator shows it with a resume form and the screenshot, POST /resume with the right token succeeds", async () => {
    session.raise(
      {
        capability_id: "member.savings_balance.lookup",
        capability_version: "1.0.0",
        goal: "Look up member 10001's savings balance",
        current_step_id: "read_balance",
        reason_code: "ambiguous_locator",
        reason: "resolved to 2 elements",
        observation,
        screenshot_path: join(screenshotsDir, "before.png"),
        session_id: session.sessionId,
        resume_token: "test-token-abc",
        raised_at: new Date().toISOString(),
        timeout_ms: 60_000,
      },
      { observation },
    );

    const interventionRes = await fetch(`${baseUrl}/intervention`);
    expect(interventionRes.status).toBe(200);
    const body = (await interventionRes.json()) as { state: string; request: Record<string, unknown> };
    expect(body.state).toBe("human");
    expect(body.request).toMatchObject({ capability_id: "member.savings_balance.lookup", current_step_id: "read_balance", reason_code: "ambiguous_locator" });

    const operatorRes = await fetch(`${baseUrl}/operator`);
    const html = await operatorRes.text();
    expect(html).toContain("Intervention required");
    expect(html).toContain("read_balance");
    expect(html).toContain("ambiguous_locator");
    expect(html).toContain('value="test-token-abc"');
    expect(html).toContain("/screenshot/before.png");

    const screenshotRes = await fetch(`${baseUrl}/screenshot/before.png`);
    expect(screenshotRes.status).toBe(200);

    const wrongTokenRes = await fetch(`${baseUrl}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }) });
    expect(wrongTokenRes.status).toBe(409);

    const resumeRes = await fetch(`${baseUrl}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "test-token-abc" }) });
    expect(resumeRes.status).toBe(200);
    expect(await resumeRes.json()).toEqual({ ok: true });
    expect(session.getState()).toBe("pending_resume");
  });

  it("POST /resume with no token is a 400, not a crash", async () => {
    const res = await fetch(`${baseUrl}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});
