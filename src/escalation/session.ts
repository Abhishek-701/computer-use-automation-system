/**
 * control_owner state machine and the replay-with-escalation orchestrator
 * (SPEC.md Section 9, P6). Explicit session state, guarded transitions —
 * not implied, not inferred.
 *
 * State machine: automation -> pending_handoff -> human -> pending_resume
 * -> automation, plus terminal abandoned.
 *
 * Scope, stated plainly (SPEC.md Section 9's own framing): this mocks
 * the human-takes-a-headed-browser step at a clean seam. The real
 * product answer is a co-browsing console over CDP screencast or VNC.
 * What's real here: the state machine's guarded transitions, the
 * InterventionRequest contract, and — the part that actually matters —
 * re-anchoring on resume (EDGE-24, implemented in src/replay/engine.ts's
 * `resumeFromStepId` path) rather than trusting where the run left off.
 */
import { randomUUID } from "node:crypto";
import { replay, type ReplayParams } from "../replay/engine.js";
import type { ReplayResultT } from "../schema/result.js";
import type { Observation, SurfaceAdapter } from "../surface/adapter.js";
import { captureScreenshot, saveObservationSnapshot, withoutScreenshot } from "../evidence/capture.js";
import { EvidenceLogger } from "../evidence/logger.js";

export type ControlOwner = "automation" | "human";
export type SessionState = "automation" | "pending_handoff" | "human" | "pending_resume" | "abandoned";

export interface InterventionRequest {
  capability_id: string;
  capability_version: string;
  goal: string;
  current_step_id: string;
  reason_code: string;
  reason: string;
  observation: Observation;
  screenshot_path?: string;
  session_id: string;
  resume_token: string;
  raised_at: string;
  timeout_ms: number;
}

export interface StateDeltaSide {
  observation: Observation;
  screenshot_path?: string;
}

export interface StateDelta {
  before: StateDeltaSide;
  after: StateDeltaSide;
}

/**
 * The stuck-detection triggers SPEC.md Section 9 names, mapped onto
 * replay's actual failure error_classes: ambiguous locator, policy
 * require_approval, a non-recoverable declared-detector condition
 * (escalate or exhausted dismiss_and_retry), and max_duration reached
 * without a checkpoint. `target_not_found` / `expect_failed` and similar
 * are deliberately NOT included — treating every failure as "stuck"
 * would escalate indiscriminately; SPEC.md's list is specific, and this
 * mirrors it rather than being maximally aggressive.
 */
const STUCK_ERROR_CLASSES = new Set(["ambiguous_locator", "requires_approval", "checkpoint_not_satisfied", "max_duration_exceeded"]);

export function isStuckCondition(errorClass: string): boolean {
  if (STUCK_ERROR_CLASSES.has(errorClass)) return true;
  if (errorClass.startsWith("not_interactable_")) return true;
  if (errorClass.startsWith("detector_")) return true; // on_condition configured "escalate"
  if (errorClass.startsWith("unrecovered_")) return true; // dismiss_and_retry exhausted
  return false;
}

export class EscalationSession {
  readonly sessionId: string = randomUUID();
  private state: SessionState = "automation";
  private request: InterventionRequest | null = null;
  private before: StateDeltaSide | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private resumeWaiters: Array<(outcome: "resumed" | "abandoned") => void> = [];

  getState(): SessionState {
    return this.state;
  }

  get controlOwner(): ControlOwner {
    return this.state === "human" || this.state === "pending_resume" ? "human" : "automation";
  }

  getRequest(): InterventionRequest | null {
    return this.request;
  }

  /** automation -> pending_handoff -> human. EDGE-22: starts the intervention's timeout, which abandons the session if nobody resumes in time. */
  raise(request: InterventionRequest, before: StateDeltaSide): void {
    if (this.state !== "automation") {
      throw new Error(`cannot raise an intervention while session is in state '${this.state}'`);
    }
    this.request = request;
    this.before = before;
    this.state = "pending_handoff";
    // The mocked operator page IS the acknowledgement (SPEC.md's "mock
    // operator UI" scope note) — a real co-browsing console would ack
    // explicitly before this transition.
    this.state = "human";
    this.timeoutHandle = setTimeout(() => this.abandon(), request.timeout_ms);
  }

  /**
   * EDGE-23: guarded. A resume signal while control_owner is already
   * automation (or the session is already abandoned) is rejected, not
   * applied.
   */
  resume(token: string): { ok: true } | { ok: false; reason: string } {
    if (this.state === "automation") return { ok: false, reason: "session is not awaiting a human; resume rejected" };
    if (this.state === "abandoned") return { ok: false, reason: "session already abandoned" };
    if (this.state === "pending_resume") return { ok: false, reason: "resume already signalled" };
    if (!this.request || token !== this.request.resume_token) return { ok: false, reason: "invalid resume token" };

    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.state = "pending_resume";
    this.notifyWaiters("resumed");
    return { ok: true };
  }

  /** Called by the orchestrator once re-anchoring has run (success or failure) — pending_resume -> automation, cycle complete. */
  complete(after: StateDeltaSide): StateDelta {
    if (this.state !== "pending_resume") {
      throw new Error(`cannot complete from state '${this.state}'`);
    }
    const delta: StateDelta = { before: this.before!, after };
    this.state = "automation";
    this.request = null;
    this.before = null;
    return delta;
  }

  /** EDGE-22: timeout expiry, or any other terminal abandonment. Closes the session. */
  abandon(): void {
    if (this.state === "automation" || this.state === "abandoned") return;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.state = "abandoned";
    this.notifyWaiters("abandoned");
  }

  /** Resolves once resume() or abandon() has been called. */
  waitForResume(): Promise<"resumed" | "abandoned"> {
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private notifyWaiters(outcome: "resumed" | "abandoned"): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve(outcome);
  }
}

export interface EscalationParams extends Omit<ReplayParams, "adapter" | "resumeFromStepId"> {
  session: EscalationSession;
  evidenceDir: string;
  logger?: EvidenceLogger;
  interventionTimeoutMs?: number;
  /**
   * `adapter` is the SAME live adapter the stuck run was using — passed
   * through so a caller driving the "human" side programmatically (an
   * evidence-capture script, an automated approval policy) can act on
   * the live session directly before resuming, exactly as a person at
   * a headed browser would. Additive: existing single-argument
   * callbacks remain valid (TS's structural typing accepts a narrower
   * function where a wider one is expected).
   */
  onIntervention?: (request: InterventionRequest, adapter: SurfaceAdapter) => void;
}

/**
 * Runs replay against a live adapter; if it gets stuck (SPEC.md
 * Section 9's trigger list), raises an intervention, waits for a human
 * to signal resume on the SAME session, re-anchors (EDGE-24), and
 * completes. Never re-navigates or trusts the prior position on resume.
 */
export async function runReplayWithEscalation(
  params: EscalationParams,
  adapter: SurfaceAdapter,
): Promise<ReplayResultT> {
  const runId = params.runId ?? `run_${randomUUID()}`;
  const timeoutMs = params.interventionTimeoutMs ?? 10 * 60 * 1000;

  const first = await replay({ ...params, runId, adapter });
  params.logger?.info("replay_attempt", runId, { status: first.status, step_id: first.failure?.step_id });

  if (first.status !== "failed" && first.status !== "failed_dirty") return first;
  if (!first.failure || !isStuckCondition(first.failure.error_class)) return first;

  // --- stuck: raise an intervention on the same live adapter ---
  const beforeCapture = await captureScreenshot(adapter, `${params.evidenceDir}/handoff`, "before");
  const request: InterventionRequest = {
    capability_id: params.artifact.capability.id,
    capability_version: params.artifact.capability.version,
    goal: params.artifact.capability.description,
    current_step_id: first.failure.step_id,
    reason_code: first.failure.error_class,
    reason: `expected: ${first.failure.expected} — observed: ${first.failure.observed}`,
    observation: withoutScreenshot(beforeCapture.observation),
    screenshot_path: beforeCapture.screenshotPath,
    session_id: params.session.sessionId,
    resume_token: randomUUID(),
    raised_at: new Date().toISOString(),
    timeout_ms: timeoutMs,
  };
  params.session.raise(request, { observation: withoutScreenshot(beforeCapture.observation), screenshot_path: beforeCapture.screenshotPath });
  saveObservationSnapshot(`${params.evidenceDir}/handoff`, "before", beforeCapture.observation);
  params.logger?.warn("intervention_raised", runId, { step_id: request.current_step_id, reason_code: request.reason_code });
  params.onIntervention?.(request, adapter);

  const outcome = await params.session.waitForResume();
  if (outcome === "abandoned") {
    params.logger?.error("intervention_abandoned", runId, { step_id: request.current_step_id });
    return first; // original failure stands
  }

  // --- resumed: re-anchor and continue (EDGE-24, implemented in engine.ts) ---
  const resumed = await replay({ ...params, runId, adapter, resumeFromStepId: request.current_step_id });
  params.logger?.info("resumed_replay", runId, { status: resumed.status });

  const afterCapture = await captureScreenshot(adapter, `${params.evidenceDir}/handoff`, "after").catch(() => null);
  const afterSide = afterCapture
    ? { observation: withoutScreenshot(afterCapture.observation), screenshot_path: afterCapture.screenshotPath }
    : { observation: withoutScreenshot(beforeCapture.observation) };
  if (afterCapture) saveObservationSnapshot(`${params.evidenceDir}/handoff`, "after", afterCapture.observation);

  // The state delta is just before.json + after.json, already on disk —
  // nothing further to write; session.complete()'s return value exists
  // for a caller that wants the pair in-process rather than from disk.
  params.session.complete(afterSide);

  return {
    ...resumed,
    control_transfers: [
      ...resumed.control_transfers,
      {
        at_step: request.current_step_id,
        reason: request.reason_code,
        handed_off_at: request.raised_at,
        resumed_at: new Date().toISOString(),
        state_delta_ref: `${params.evidenceDir}/handoff/`,
      },
    ],
  };
}
