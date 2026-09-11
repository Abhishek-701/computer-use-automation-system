/**
 * Screenshot / observation snapshot capture (SPEC.md Section 4, P6).
 * Thin wrappers around SurfaceAdapter.observe({screenshot:true}) — no
 * Playwright here, just file writes, matching invariant #2 (the same
 * capture code works against any adapter).
 *
 * Trace capture is explicitly not implemented: SurfaceAdapter has no
 * tracing primitive (Playwright's tracing API lives on BrowserContext,
 * below the adapter boundary), and result.ts's EvidenceRefs.trace is
 * optional for exactly this reason. Named as a cut in REPORT.md, not
 * silently omitted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Observation, SurfaceAdapter } from "../surface/adapter.js";

export interface Capture {
  screenshotPath: string;
  observation: Observation;
}

/** Captures a screenshot + the observation it was taken from, writing the PNG to `<dir>/<name>.png`. */
export async function captureScreenshot(adapter: SurfaceAdapter, dir: string, name: string): Promise<Capture> {
  const observation = await adapter.observe({ screenshot: true });
  if (!observation.screenshot) {
    throw new Error("adapter did not return a screenshot for a screenshot:true observe() call");
  }
  mkdirSync(dir, { recursive: true });
  const screenshotPath = join(dir, `${name}.png`);
  writeFileSync(screenshotPath, observation.screenshot);
  return { screenshotPath, observation };
}

/**
 * Saves a pruned observation as JSON, independent of whether a
 * screenshot was also taken — and always WITHOUT one, even if this
 * particular Observation object has `screenshot` populated (e.g. it
 * came from captureScreenshot()'s return value). A Buffer serializes to
 * JSON as a huge flat array of byte integers; the PNG bytes already
 * have a proper home as an actual image file, and duplicating them
 * bloated into this JSON file is pure waste, not a second useful copy.
 */
export function saveObservationSnapshot(dir: string, name: string, observation: Observation): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  const { url, nodes } = observation;
  writeFileSync(path, JSON.stringify({ url, nodes }, null, 2) + "\n", "utf-8");
  return path;
}

export function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Drops a captured screenshot buffer from an Observation before it goes
 * anywhere that gets serialized wholesale (an InterventionRequest, a
 * JSON HTTP response, a log line) — same reasoning as
 * saveObservationSnapshot: the PNG bytes already have a proper home as
 * an image file, and JSON-serializing a Buffer is a byte-integer-per-line
 * blowup, not a usable second copy.
 */
export function withoutScreenshot(observation: Observation): Observation {
  const { url, nodes } = observation;
  return { url, nodes };
}
