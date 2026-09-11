/**
 * Intervention endpoint + mock operator page (SPEC.md Section 9, P6).
 *
 * This is the deliberately-mocked seam: a bare HTML page and three
 * plain HTTP endpoints, not a real co-browsing console. What it's
 * actually for is narrow and real — showing a human *why* automation
 * stopped and *where*, and letting them signal "I've fixed it, resume"
 * once they've driven the live (headed) browser window directly. The
 * manual driving itself happens outside this server entirely, in the
 * visible Playwright window; this page never touches the page's DOM.
 */
import express from "express";
import { basename } from "node:path";
import type { EscalationSession } from "./session.js";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body>
${body}
</body>
</html>`;
}

function operatorPage(session: EscalationSession): string {
  const request = session.getRequest();
  if (!request) {
    return page("Operator", "<h1>No active intervention</h1><p>Nothing is currently stuck.</p>");
  }
  const screenshotTag = request.screenshot_path
    ? `<img src="/screenshot/${esc(basename(request.screenshot_path))}" style="max-width:900px;border:1px solid #999" alt="stuck state screenshot">`
    : "<p>(no screenshot captured)</p>";

  return page(
    "Operator — Intervention required",
    `<h1>Intervention required</h1>
<table border="1" cellpadding="6" cellspacing="0">
  <tr><td>Capability</td><td>${esc(request.capability_id)} v${esc(request.capability_version)}</td></tr>
  <tr><td>Goal</td><td>${esc(request.goal)}</td></tr>
  <tr><td>Step</td><td>${esc(request.current_step_id)}</td></tr>
  <tr><td>Reason</td><td>${esc(request.reason_code)} — ${esc(request.reason)}</td></tr>
  <tr><td>Raised at</td><td>${esc(request.raised_at)}</td></tr>
  <tr><td>Session</td><td>${esc(request.session_id)}</td></tr>
</table>
${screenshotTag}
<p>Drive the live browser window directly to resolve this — it is the
same session automation was using, not a fresh one. Once resolved, click
Resume; the run re-observes from scratch and re-anchors rather than
trusting where it left off.</p>
<form method="post" action="/resume">
  <input type="hidden" name="token" value="${esc(request.resume_token)}">
  <button type="submit">Resume automation</button>
</form>`,
  );
}

export function createEscalationServer(session: EscalationSession, screenshotsDir: string): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/intervention", (_req, res) => {
    const request = session.getRequest();
    if (!request) {
      res.status(404).json({ error: "no active intervention" });
      return;
    }
    res.json({ state: session.getState(), request });
  });

  app.get("/screenshot/:name", (req, res) => {
    res.sendFile(req.params["name"] as string, { root: screenshotsDir }, (err) => {
      if (err) res.status(404).end();
    });
  });

  app.get("/operator", (_req, res) => {
    res.type("html").send(operatorPage(session));
  });

  app.post("/resume", (req, res) => {
    const token = (req.body?.["token"] ?? req.query?.["token"]) as unknown;
    if (typeof token !== "string" || token.length === 0) {
      res.status(400).json({ ok: false, reason: "missing token" });
      return;
    }
    const result = session.resume(token);
    res.status(result.ok ? 200 : 409).json(result);
  });

  return app;
}
