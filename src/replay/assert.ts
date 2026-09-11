/**
 * Expectations and checkpoints (SPEC.md Section 4, P4). Wraps detect.ts
 * with a poll-until-stable wait, used for both a step's `expect`
 * (EDGE-16: after a `type` action, assert the field's actual value —
 * generalised here to any step with an `expect`) and the artifact's
 * `success.checkpoint`.
 *
 * EDGE-13 / EDGE-11 distinction, stated precisely because it looks like
 * a contradiction otherwise: EDGE-11 forbids a *fixed* wall-clock delay
 * ("wait 5000ms, then proceed regardless of what's true"). This is not
 * that — it re-observes and re-checks the condition on a short interval
 * and returns the instant the condition holds (for `stableChecks`
 * consecutive polls, so a loading state's transient flicker can't
 * satisfy it — EDGE-13), or reports failure the instant the deadline
 * passes. The small `setTimeout` between polls is the polling
 * *mechanism*, never a substitute for checking — a slow app returns
 * as soon as it's actually ready, a broken one still fails at the
 * declared timeout, neither waits a fixed duration on faith.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { ConditionT, LocatorT } from "../schema/artifact.js";
import type { Observation } from "../surface/adapter.js";
import { evaluateCondition, findMatchingNodes } from "./detect.js";

export interface WaitOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  stableChecks?: number;
}

export interface WaitResult {
  satisfied: boolean;
  lastObservation: Observation;
}

export async function waitForCondition(
  observe: () => Promise<Observation>,
  condition: ConditionT,
  paramValues: Record<string, string>,
  opts: WaitOptions,
  selfTarget?: LocatorT,
): Promise<WaitResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? 150;
  const stableChecks = opts.stableChecks ?? 2;
  const deadline = Date.now() + opts.timeoutMs;

  let consecutiveTrue = 0;
  let lastObservation = await observe();

  for (;;) {
    const selfNode = selfTarget ? findMatchingNodes(selfTarget, lastObservation)[0] : undefined;
    const holds = evaluateCondition(condition, {
      observation: lastObservation,
      paramValues,
      ...(selfNode ? { selfNode } : {}),
    });

    if (holds) {
      consecutiveTrue++;
      if (consecutiveTrue >= stableChecks) {
        return { satisfied: true, lastObservation };
      }
    } else {
      consecutiveTrue = 0;
    }

    if (Date.now() >= deadline) {
      return { satisfied: false, lastObservation };
    }
    await delay(pollIntervalMs);
    lastObservation = await observe();
  }
}
