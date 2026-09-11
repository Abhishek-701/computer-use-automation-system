/**
 * Candidate resolution + drift reporting (SPEC.md Section 4, P4).
 *
 * A thin wrapper over SurfaceAdapter.resolve(), which already tries a
 * TargetSpec's primary locator then its fallbacks in order (EDGE-06:
 * never takes the first match on ambiguity) and reports which one
 * succeeded. This file's only job is turning "resolved via something
 * other than primary" into the drift record the result contract
 * (SPEC.md Section 7 `warnings.locator_drift`) expects — the adapter
 * itself has no concept of "drift", only of which candidate matched.
 *
 * Bounded retry on `not_found` only (EDGE-11: wait on conditions, not a
 * fixed delay — this returns the instant resolution succeeds, or the
 * instant the deadline passes, never a blind fixed wait). This exists
 * for the real gap between an action completing and the resulting
 * navigation's DOM actually settling: `resolve()` itself is one-shot by
 * design (SurfaceAdapter stays a thin, direct surface primitive), so
 * the *patience* for "the page just navigated, give it a moment" lives
 * here, in replay, not in the adapter. Deliberately NOT retried on
 * `ambiguous` or `not_interactable` — those are usually stable facts
 * about the page, not a loading transient, and retrying them would only
 * delay reporting a real problem.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { SurfaceAdapter, Resolution } from "../surface/adapter.js";
import type { TargetSpecT } from "../schema/artifact.js";

export interface LocateResult {
  resolution: Resolution;
  drift?: { primary_failed: string; resolved_via: string };
}

export async function locate(adapter: SurfaceAdapter, target: TargetSpecT, timeoutMs = 2000): Promise<LocateResult> {
  const deadline = Date.now() + timeoutMs;
  let resolution = await adapter.resolve(target);
  while (resolution.status === "not_found" && Date.now() < deadline) {
    await delay(150);
    resolution = await adapter.resolve(target);
  }
  if (resolution.status === "ok" && resolution.resolvedVia !== "primary") {
    return { resolution, drift: { primary_failed: "primary", resolved_via: resolution.resolvedVia } };
  }
  return { resolution };
}
