/**
 * The deterministic replay executor (SPEC.md Section 4/5 P4, invariant
 * #2 — discovery and replay share this one adapter, one action
 * vocabulary, one gate; only who selects the next action differs, and
 * replay's answer is "the artifact, not a model").
 *
 * Scope note, stated up front because it shapes several decisions
 * below: this file is a *single deterministic pass*. It never itself
 * produces `status: "escalated"` — that status is the output of the
 * escalation session machinery (src/escalation/session.ts, CP7), which
 * wraps a `failed` result whose `error_class` matches a stuck-shaped
 * pattern (ambiguous_locator, not_interactable_*, requires_approval,
 * an unrecovered known detector) and turns it into a live human
 * handoff, then resumes by re-invoking this engine from a later step.
 * Keeping escalation *policy* out of engine.ts is what keeps this file
 * a pure, single-pass, fully unit-testable executor.
 *
 * Failure vs. failed_dirty (EDGE-10): once any step marked `mutating`
 * has executed, every failure from that point on is `failed_dirty`
 * instead of `failed` — the target system may be in a partially
 * changed state, and blind retry is unsafe.
 */
import { randomUUID } from "node:crypto";
import { ArtifactSchema, type Artifact, type OutcomeOverrideT, type StepOverrideT, type StepT } from "../schema/artifact.js";
import type { ActionT, ParamOrLiteralT } from "../schema/action.js";
import type { FailurePhaseT, ReplayResultT } from "../schema/result.js";
import type { Observation, SurfaceAdapter } from "../surface/adapter.js";
import { enforce, checkOriginAndRoute, type PolicyT } from "../policy/gate.js";
import { locate } from "./locator.js";
import { waitForCondition } from "./assert.js";
import { evaluateCondition } from "./detect.js";
import { captureScreenshot } from "../evidence/capture.js";

export interface ReplayParams {
  artifact: Artifact;
  inputs: Record<string, string>;
  baseUrl: string;
  policy: PolicyT;
  tenant?: string;
  allowDraft?: boolean;
  runId?: string;
  /**
   * When given, any hard failure captures a screenshot to
   * `<evidenceDir>/failure.png` and references it as both
   * `failure.evidence_ref` and `evidence.screenshots[0]` (SPEC.md
   * Section 7's result contract shows this populated; the brief asks
   * for "at least one richer signal on failure"). Best-effort: capture
   * failing (e.g. the adapter/session is already dead) never masks the
   * real failure being reported.
   */
  evidenceDir?: string;
  /**
   * Required, not defaulted: engine.ts stays free of any Playwright
   * import at all (not even our own PlaywrightWebAdapter class) so the
   * "no Playwright above src/surface/" invariant holds unambiguously
   * for this file, not just in spirit. The caller (CLI, CP8) wires
   * `PlaywrightWebAdapter.create` in; tests can inject anything that
   * satisfies SurfaceAdapter. Ignored when `adapter` is given.
   */
  createAdapter: (entryUrl: string) => Promise<SurfaceAdapter>;
  /**
   * An already-live adapter to drive instead of creating one — and,
   * unlike the normal path, replay() does NOT close it when done; the
   * caller owns its lifecycle. Used by src/escalation/session.ts to
   * keep the *same* browser session alive across a human handoff
   * (SPEC.md Section 9: "the same live session... not a fresh one").
   */
  adapter?: SurfaceAdapter;
  /**
   * Resume support (EDGE-24). When set, replay() does NOT navigate to
   * entry_point or run the EDGE-12 precondition check — the human may
   * have navigated anywhere. Instead it re-observes from scratch and
   * re-anchors: if the success checkpoint already holds, it "skips
   * ahead" by performing only the remaining `read` actions (safe,
   * non-mutating) against the current state and returns success/
   * fails cleanly on capturing outputs; otherwise it retries resolving
   * this exact step's target once — if that now resolves, it
   * *continues* normally from here; if not, it *fails* with
   * `resume_reanchor_failed` rather than guessing further. A full
   * "skip to an arbitrary later step" would need per-step
   * preconditions this schema doesn't model — named as a limitation,
   * not silently assumed away (see REPORT.md Cuts).
   */
  resumeFromStepId?: string;
}

const CHECKPOINT_TIMEOUT_MS = 10_000;

/**
 * Sparse per-tenant overlay merge (SPEC.md Section 6). Re-validates the
 * merged result against the schema before returning it (SPEC.md
 * Section 6: "A merged artifact is re-validated against the schema
 * before execution"). An overlay referencing an unknown step id or
 * outcome code is a load error, not a silent no-op.
 */
export function mergeOverlay(artifact: Artifact, tenant: string): Artifact {
  const overlay = artifact.overlays?.[tenant];
  if (!overlay) return artifact;

  const stepIds = new Set(artifact.steps.map((s) => s.id));
  for (const id of Object.keys(overlay.steps)) {
    if (!stepIds.has(id)) {
      throw new Error(`overlay for tenant '${tenant}' references unknown step id '${id}'`);
    }
  }
  const outcomeCodes = new Set(artifact.outcomes.map((o) => o.code));
  for (const code of Object.keys(overlay.outcomes)) {
    if (!outcomeCodes.has(code)) {
      throw new Error(`overlay for tenant '${tenant}' references unknown outcome code '${code}'`);
    }
  }

  const merged: Artifact = {
    ...artifact,
    steps: artifact.steps.map((step) => applyStepOverride(step, overlay.steps[step.id])),
    outcomes: artifact.outcomes.map((outcome) => applyOutcomeOverride(outcome, overlay.outcomes[outcome.code])),
  };
  return ArtifactSchema.parse(merged);
}

/**
 * Field-by-field merge (not `{...step, ...patch}`) so an absent patch
 * field never overwrites the base with an explicit `undefined` —
 * required under strict `exactOptionalPropertyTypes`, and also just
 * the correct semantics for a *sparse* patch.
 */
function applyStepOverride(step: StepT, patch: StepOverrideT | undefined): StepT {
  if (!patch) return step;
  return {
    ...step,
    ...(patch.action ? { action: patch.action } : {}),
    ...(patch.target ? { target: patch.target } : {}),
    ...(patch.expect ? { expect: patch.expect } : {}),
    ...(patch.on_condition ? { on_condition: patch.on_condition } : {}),
    ...(patch.timeout_ms ? { timeout_ms: patch.timeout_ms } : {}),
  };
}

function applyOutcomeOverride(outcome: Artifact["outcomes"][number], patch: OutcomeOverrideT | undefined): Artifact["outcomes"][number] {
  if (!patch) return outcome;
  return {
    ...outcome,
    ...(patch.detector ? { detector: patch.detector } : {}),
    ...(patch.message !== undefined ? { message: patch.message } : {}),
    ...(patch.terminal !== undefined ? { terminal: patch.terminal } : {}),
    ...(patch.precedence !== undefined ? { precedence: patch.precedence } : {}),
  };
}

function literalOf(value: ParamOrLiteralT, inputs: Record<string, string>): string {
  if (typeof value === "string") return value;
  const v = inputs[value.$param];
  if (v === undefined) throw new Error(`unbound parameter: ${value.$param}`);
  return v;
}

/** Substitutes $param values and {route_param} URL placeholders (EDGE-02) into a concrete, literal Action. */
function concreteAction(action: ActionT, inputs: Record<string, string>): ActionT {
  switch (action.type) {
    case "navigate":
      return {
        type: "navigate",
        url: action.url.replace(/\{(\w+)\}/g, (_match, name: string) => {
          const v = inputs[name];
          if (v === undefined) throw new Error(`unbound route parameter: ${name}`);
          return v;
        }),
      };
    case "type":
      return { type: "type", value: literalOf(action.value, inputs) };
    case "select":
      return { type: "select", value: literalOf(action.value, inputs) };
    case "click":
    case "read":
      return action;
  }
}

class ReplayHalt {
  constructor(public readonly result: ReplayResultT) {}
}

export async function replay(params: ReplayParams): Promise<ReplayResultT> {
  const runId = params.runId ?? `run_${randomUUID()}`;
  const startedAtMs = Date.now();
  const tenant = params.tenant;

  const buildFailure = (opts: {
    stepId: string;
    phase: FailurePhaseT;
    expected: string;
    observed: string;
    errorClass: string;
    mutatingCrossed: boolean;
  }): ReplayResultT => ({
    status: opts.mutatingCrossed ? "failed_dirty" : "failed",
    capability_id: params.artifact.capability.id,
    capability_version: params.artifact.capability.version,
    ...(tenant ? { tenant } : {}),
    run_id: runId,
    started_at: new Date(startedAtMs).toISOString(),
    duration_ms: Date.now() - startedAtMs,
    outputs: {},
    failure: {
      step_id: opts.stepId,
      phase: opts.phase,
      expected: opts.expected,
      observed: opts.observed,
      error_class: opts.errorClass,
    },
    control_transfers: [],
    // Real log capture is src/evidence/logger.ts's job (CP7, single sink
    // per invariant #3); this is the path convention it will write to.
    evidence: { log: `evidence/${runId}/log.jsonl`, screenshots: [] },
  });

  // --- pre-flight, before any adapter exists ---------------------------
  let artifact: Artifact;
  try {
    artifact = tenant ? mergeOverlay(params.artifact, tenant) : params.artifact;
  } catch (err) {
    return buildFailure({
      stepId: "(preflight)",
      phase: "resolve",
      expected: "overlay merges onto known step ids and outcome codes",
      observed: err instanceof Error ? err.message : String(err),
      errorClass: "invalid_overlay",
      mutatingCrossed: false,
    });
  }

  if (artifact.capability.status === "draft" && !params.allowDraft) {
    return buildFailure({
      stepId: "(preflight)",
      phase: "resolve",
      expected: "capability.status is 'verified' or 'approved', or --allow-draft was passed",
      observed: `capability.status is 'draft'`,
      errorClass: "draft_not_allowed",
      mutatingCrossed: false,
    });
  }

  const entryUrl = new URL(artifact.target.entry_point, params.baseUrl).toString();
  const ownsAdapter = !params.adapter;
  const adapter = params.adapter ?? (await params.createAdapter(entryUrl));

  let mutatingCrossed = false;
  const outputs: Record<string, string | number | boolean> = {};
  const capturedReads: Record<string, string> = {};
  const locatorDrift: { step_id: string; primary_failed: string; resolved_via: string }[] = [];
  const recoveredConditions: { step_id: string; condition: string; attempts: number }[] = [];

  const observeChecked = async (): Promise<Observation> => {
    const observation = await adapter.observe();
    const check = checkOriginAndRoute(observation.url, params.policy);
    if (check.decision !== "allow") {
      throw new ReplayHalt(
        buildFailure({
          stepId: "(passive-navigation)",
          phase: "resolve",
          expected: "current url stays within the policy allowlist",
          observed: check.decision === "block" ? check.reason : "require_approval",
          errorClass: "policy_blocked",
          mutatingCrossed,
        }),
      );
    }
    return observation;
  };

  /** Best-effort failure-capture (P6, SPEC.md §7's `failure.evidence_ref`): never lets a capture problem mask the real failure being reported. */
  const attachFailureEvidence = async (result: ReplayResultT): Promise<ReplayResultT> => {
    if (!params.evidenceDir || !result.failure) return result;
    try {
      const capture = await captureScreenshot(adapter, params.evidenceDir, "failure");
      return {
        ...result,
        failure: { ...result.failure, evidence_ref: capture.screenshotPath },
        evidence: { ...result.evidence, screenshots: [capture.screenshotPath] },
      };
    } catch {
      return result;
    }
  };

  try {
    let observation = await observeChecked();

    // EDGE-12: precondition_false — a stale confirmation banner from a
    // previous run must not produce a false pass on this one. Skipped
    // on resume: we are deliberately not at the start of a run, and a
    // checkpoint already being true is the expected "skip ahead" case
    // handled by the re-anchoring logic below, not a stale-state bug.
    if (artifact.success.precondition_false && !params.resumeFromStepId) {
      const already = evaluateCondition(artifact.success.checkpoint, { observation, paramValues: params.inputs });
      if (already) {
        throw new ReplayHalt(
          buildFailure({
            stepId: "(preflight)",
            phase: "checkpoint",
            expected: "success checkpoint is false before any step runs",
            observed: "success checkpoint was already true at run start",
            errorClass: "precondition_already_true",
            mutatingCrossed,
          }),
        );
      }
    }

    const sortedOutcomes = [...artifact.outcomes].sort((a, b) => a.precedence - b.precedence);
    const checkOutcomes = (stepId: string): ReplayResultT | undefined => {
      for (const outcome of sortedOutcomes) {
        if (evaluateCondition(outcome.detector, { observation, paramValues: params.inputs })) {
          return {
            status: "business_outcome",
            capability_id: artifact.capability.id,
            capability_version: artifact.capability.version,
            ...(tenant ? { tenant } : {}),
            run_id: runId,
            started_at: new Date(startedAtMs).toISOString(),
            duration_ms: Date.now() - startedAtMs,
            outputs: {},
            outcome: {
              code: outcome.code,
              ...(outcome.message ? { message: outcome.message } : {}),
              detected_at_step: stepId,
            },
            control_transfers: [],
            evidence: { log: `evidence/${runId}/log.jsonl`, screenshots: [] },
          };
        }
      }
      return undefined;
    };

    // --- resume re-anchoring (EDGE-24) ---
    // Never trust the prior position. Re-observe (already done above,
    // via observeChecked()), then decide: checkpoint already true means
    // the human finished the task by hand — skip ahead by capturing any
    // remaining declared outputs (never re-running a mutating action
    // against state a human already produced) and returning success.
    // Otherwise, retry resolving exactly this step's own target once —
    // if it resolves now, continue normally from here; if not, fail
    // cleanly rather than guess further.
    let startIndex = 0;
    if (params.resumeFromStepId) {
      const idx = artifact.steps.findIndex((s) => s.id === params.resumeFromStepId);
      if (idx === -1) {
        throw new ReplayHalt(
          buildFailure({
            stepId: params.resumeFromStepId,
            phase: "resolve",
            expected: "resumeFromStepId exists in the artifact",
            observed: "no such step id",
            errorClass: "resume_step_not_found",
            mutatingCrossed,
          }),
        );
      }

      let reanchorObservation: Observation;
      try {
        reanchorObservation = await observeChecked();
      } catch (err) {
        if (err instanceof ReplayHalt) throw err;
        // EDGE-25: the session is dead on resume (browser closed, logged
        // out) — fail with a specific error class, not an opaque throw.
        throw new ReplayHalt(
          buildFailure({
            stepId: params.resumeFromStepId,
            phase: "resolve",
            expected: "the live session is still reachable on resume",
            observed: err instanceof Error ? err.message : String(err),
            errorClass: "session_dead",
            mutatingCrossed,
          }),
        );
      }
      observation = reanchorObservation;

      const alreadyDone = evaluateCondition(artifact.success.checkpoint, { observation, paramValues: params.inputs });
      if (alreadyDone) {
        for (const step of artifact.steps.slice(idx)) {
          if (step.action.type !== "read") continue;
          const located = await locate(adapter, step.target, step.timeout_ms);
          if (located.resolution.status !== "ok") {
            const [expected, observed] = describeResolutionFailure(located.resolution);
            throw new ReplayHalt(
              buildFailure({ stepId: step.id, phase: "resolve", expected, observed, errorClass: "resume_reanchor_failed", mutatingCrossed }),
            );
          }
          const actResult = await adapter.act({ type: "read" });
          if (actResult.ok && actResult.value !== undefined) capturedReads[step.id] = actResult.value;
        }
        startIndex = artifact.steps.length; // skip the main loop; fall through to final checkpoint + output collection
      } else {
        const retryLocate = await locate(adapter, artifact.steps[idx]!.target, artifact.steps[idx]!.timeout_ms);
        if (retryLocate.resolution.status !== "ok") {
          throw new ReplayHalt(
            buildFailure({
              stepId: params.resumeFromStepId,
              phase: "resolve",
              expected: "the failed step's target resolves after human intervention",
              observed: "still not resolvable after resume",
              errorClass: "resume_reanchor_failed",
              mutatingCrossed,
            }),
          );
        }
        startIndex = idx;
      }
    }

    for (const step of artifact.steps.slice(startIndex)) {
      if (Date.now() - startedAtMs > params.policy.max_duration_ms) {
        throw new ReplayHalt(
          buildFailure({
            stepId: step.id,
            phase: "act",
            expected: `run completes within ${params.policy.max_duration_ms}ms`,
            observed: `exceeded max_duration_ms before step '${step.id}'`,
            errorClass: "max_duration_exceeded",
            mutatingCrossed,
          }),
        );
      }

      // --- declared on_condition handling (interstitials, session expiry) ---
      for (const cond of step.on_condition) {
        const name = cond.when.replace(/^detector:/, "");
        const detector = params.policy.known_detectors[name];
        if (!detector) continue;

        let present = evaluateCondition(detector.condition, { observation, paramValues: params.inputs });
        if (!present) continue;

        if (cond.do === "escalate") {
          throw new ReplayHalt(
            buildFailure({
              stepId: step.id,
              phase: "act",
              expected: `detector '${name}' does not fire`,
              observed: `detector '${name}' fired and is configured to escalate`,
              errorClass: `detector_${name}`,
              mutatingCrossed,
            }),
          );
        }

        // dismiss_and_retry, bounded (EDGE-11/anti-goal: retries are declared, bounded, named).
        const max = cond.max ?? 1;
        let attempts = 0;
        while (present && attempts < max && detector.dismiss) {
          attempts++;
          const dismissLocate = await locate(adapter, detector.dismiss, step.timeout_ms);
          if (dismissLocate.resolution.status !== "ok") break;
          const clickResult = await adapter.act({ type: "click" });
          if (!clickResult.ok) break;
          observation = await observeChecked();
          present = evaluateCondition(detector.condition, { observation, paramValues: params.inputs });
        }
        if (!present && attempts > 0) {
          recoveredConditions.push({ step_id: step.id, condition: name, attempts });
        }
        if (present) {
          throw new ReplayHalt(
            buildFailure({
              stepId: step.id,
              phase: "act",
              expected: `detector '${name}' dismissed within ${max} attempt(s)`,
              observed: `detector '${name}' still present after ${attempts} attempt(s)`,
              errorClass: `unrecovered_${name}`,
              mutatingCrossed,
            }),
          );
        }
      }

      // --- policy gate (invariant #1: the single door to the adapter) ---
      const decision = enforce(step.action, { url: observation.url, artifact: artifact.capability, step, mode: "replay" }, params.policy);
      if (decision.decision === "block") {
        throw new ReplayHalt(
          buildFailure({
            stepId: step.id,
            phase: "act",
            expected: "policy gate allows this action",
            observed: decision.reason,
            errorClass: "policy_blocked",
            mutatingCrossed,
          }),
        );
      }
      if (decision.decision === "require_approval") {
        throw new ReplayHalt(
          buildFailure({
            stepId: step.id,
            phase: "act",
            expected: "action does not require approval",
            observed: decision.reason,
            errorClass: "requires_approval",
            mutatingCrossed,
          }),
        );
      }

      // --- resolve + act ---
      const action = concreteAction(step.action, params.inputs);

      if (action.type !== "navigate") {
        const located = await locate(adapter, step.target, step.timeout_ms);
        if (located.drift) locatorDrift.push({ step_id: step.id, ...located.drift });

        if (located.resolution.status !== "ok") {
          const [expected, observed, errorClass] = describeResolutionFailure(located.resolution);
          throw new ReplayHalt(buildFailure({ stepId: step.id, phase: "resolve", expected, observed, errorClass, mutatingCrossed }));
        }
      }

      const actResult = await adapter.act(action);
      if (!actResult.ok) {
        throw new ReplayHalt(
          buildFailure({
            stepId: step.id,
            phase: "act",
            expected: `${action.type} action succeeds`,
            observed: actResult.message,
            errorClass: actResult.errorClass,
            mutatingCrossed,
          }),
        );
      }
      if (action.type === "read" && actResult.value !== undefined) {
        capturedReads[step.id] = actResult.value;
      }
      if (step.mutating) mutatingCrossed = true;

      // --- per-step expect (EDGE-16, generalised to any step with one) ---
      if (step.expect) {
        const waited = await waitForCondition(observeChecked, step.expect, params.inputs, { timeoutMs: step.timeout_ms }, step.target.primary);
        observation = waited.lastObservation;
        if (!waited.satisfied) {
          throw new ReplayHalt(
            buildFailure({
              stepId: step.id,
              phase: "expect",
              expected: JSON.stringify(step.expect),
              observed: `expect not satisfied within ${step.timeout_ms}ms`,
              errorClass: "expect_failed",
              mutatingCrossed,
            }),
          );
        }
      } else {
        observation = await observeChecked();
      }

      // --- outcome detectors, precedence order, before the success checkpoint (EDGE-14) ---
      const outcomeResult = checkOutcomes(step.id);
      if (outcomeResult) return outcomeResult;
    }

    // --- final success checkpoint (EDGE-13: stable, not first transient match) ---
    const checkpointWait = await waitForCondition(observeChecked, artifact.success.checkpoint, params.inputs, {
      timeoutMs: CHECKPOINT_TIMEOUT_MS,
    });
    observation = checkpointWait.lastObservation;

    const finalOutcome = checkOutcomes(artifact.steps[artifact.steps.length - 1]?.id ?? "(final)");
    if (finalOutcome) return finalOutcome;

    if (!checkpointWait.satisfied) {
      throw new ReplayHalt(
        buildFailure({
          stepId: "(checkpoint)",
          phase: "checkpoint",
          expected: JSON.stringify(artifact.success.checkpoint),
          observed: `checkpoint not satisfied within ${CHECKPOINT_TIMEOUT_MS}ms; last observation had ${observation.nodes.length} nodes`,
          errorClass: "checkpoint_not_satisfied",
          mutatingCrossed,
        }),
      );
    }

    for (const output of artifact.outputs) {
      const value = capturedReads[output.from_step];
      if (value !== undefined) outputs[output.name] = value;
      else if (output.required) {
        throw new ReplayHalt(
          buildFailure({
            stepId: output.from_step,
            phase: "checkpoint",
            expected: `output '${output.name}' captured by step '${output.from_step}'`,
            observed: "no value was captured (from_step never ran a read action, or produced none)",
            errorClass: "missing_required_output",
            mutatingCrossed,
          }),
        );
      }
    }

    return {
      status: "success",
      capability_id: artifact.capability.id,
      capability_version: artifact.capability.version,
      ...(tenant ? { tenant } : {}),
      run_id: runId,
      started_at: new Date(startedAtMs).toISOString(),
      duration_ms: Date.now() - startedAtMs,
      outputs,
      control_transfers: [],
      evidence: { log: `evidence/${runId}/log.jsonl`, screenshots: [] },
      warnings: { locator_drift: locatorDrift, recovered_conditions: recoveredConditions },
    };
  } catch (err) {
    const result =
      err instanceof ReplayHalt
        ? err.result
        : buildFailure({
            stepId: "(unknown)",
            phase: "act",
            expected: "no unexpected adapter/engine exception",
            observed: err instanceof Error ? err.message : String(err),
            errorClass: "unexpected_error",
            mutatingCrossed,
          });
    return await attachFailureEvidence(result);
  } finally {
    if (ownsAdapter) await adapter.close();
  }
}

function describeResolutionFailure(resolution: { status: string; matchCount?: number; reason?: string }): [string, string, string] {
  switch (resolution.status) {
    case "ambiguous":
      return ["target resolves to exactly 1 element", `resolved to ${resolution.matchCount} elements`, "ambiguous_locator"];
    case "not_interactable":
      return ["target is visible and enabled", `not interactable: ${resolution.reason}`, `not_interactable_${resolution.reason}`];
    case "not_found":
    default:
      return ["target resolves to exactly 1 element", "resolved to 0 elements", "target_not_found"];
  }
}
