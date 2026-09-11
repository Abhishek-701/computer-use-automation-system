/**
 * Trajectory -> artifact: pruning, parameterisation (SPEC.md Section 4,
 * P5). Pure and Playwright-free — everything here is a data
 * transformation over a recorded trajectory, independently testable
 * without a live browser or a live model.
 */
import { randomUUID } from "node:crypto";
import { ArtifactSchema, type Artifact, type ConditionT, type StepT, type TargetSpecT } from "../schema/artifact.js";
import type { ActionT, ParamOrLiteralT } from "../schema/action.js";
import { matchesIrreversibleRule, type PolicyT } from "../policy/gate.js";
import type { GoalSpec } from "./prompt.js";

export interface TrajectoryStep {
  index: number;
  reasoning?: string;
  toolName: "navigate" | "click" | "type" | "select" | "read";
  action: ActionT;
  target?: TargetSpecT;
  resolvedVia?: string;
  outputName?: string;
  capturedValue?: string;
}

/**
 * EDGE-01: substitutes a literal input value with `{"$param": name}`
 * wherever it appears as an action's typed/selected value — and ONLY
 * there. Never touches observed text, detector patterns, or anything
 * else (EDGE-03) — those are operator-declared data this function
 * never sees in the first place, which is a structural guarantee, not
 * a rule this function has to remember to follow.
 */
function parameterizeValue(literal: string, inputs: GoalSpec["inputs"], inputValues: Record<string, string>): ParamOrLiteralT {
  const match = inputs.find((i) => (inputValues[i.name] ?? i.example) === literal);
  return match ? { $param: match.name } : literal;
}

function parameterizeAction(action: ActionT, goalSpec: GoalSpec, inputValues: Record<string, string>): ActionT {
  if (action.type === "type" || action.type === "select") {
    const literal = typeof action.value === "string" ? action.value : action.value.$param;
    return { type: action.type, value: parameterizeValue(literal, goalSpec.inputs, inputValues) };
  }
  if (action.type === "navigate") {
    return { type: "navigate", url: canonicalizeRoute(action.url, goalSpec.inputs, inputValues) };
  }
  return action;
}

/** EDGE-02: a literal input value inside a URL path becomes a `{name}` route placeholder. */
export function canonicalizeRoute(url: string, inputs: GoalSpec["inputs"], inputValues: Record<string, string>): string {
  let out = url;
  for (const input of inputs) {
    const literal = inputValues[input.name] ?? input.example;
    if (literal.length === 0) continue;
    out = out.split(literal).join(`{${input.name}}`);
  }
  return out;
}

function stepId(step: TrajectoryStep): string {
  return `${step.toolName}_${step.index}`;
}

/**
 * Read steps whose `output_name` doesn't match a declared output are
 * exploratory, not part of the capability's contract — pruned. A read
 * that DOES match a declared output is kept once; a duplicate read of
 * the same output (the model re-checking itself) is pruned too.
 */
function isPrunableStep(step: TrajectoryStep, goalSpec: GoalSpec, seenOutputs: Set<string>): boolean {
  if (step.toolName !== "read") return false;
  if (!step.outputName || !goalSpec.outputs.some((o) => o.name === step.outputName)) return true;
  if (seenOutputs.has(step.outputName)) return true;
  seenOutputs.add(step.outputName);
  return false;
}

function isConsecutiveDuplicate(a: TrajectoryStep, b: TrajectoryStep): boolean {
  if (a.toolName !== b.toolName) return false;
  if (JSON.stringify(a.action) !== JSON.stringify(b.action)) return false;
  if (JSON.stringify(a.target?.primary) !== JSON.stringify(b.target?.primary)) return false;
  return true;
}

/**
 * Drops steps that don't earn a place in the persisted artifact: reads
 * not mapped to a declared output (or a duplicate read of one already
 * captured), and an action that's an exact repeat of the one right
 * before it. See EDGE-27/EDGE-28: if this pruning turns out to have
 * removed something the flow actually needed, the mandatory
 * verification replay in loop.ts's orchestrator will fail and fall
 * back to the unpruned trajectory — this function's job is only to
 * produce the pruned candidate, not to guarantee it replays.
 */
export function pruneTrajectory(trajectory: TrajectoryStep[], goalSpec: GoalSpec): TrajectoryStep[] {
  const seenOutputs = new Set<string>();
  const out: TrajectoryStep[] = [];
  for (const step of trajectory) {
    if (isPrunableStep(step, goalSpec, seenOutputs)) continue;
    const prev = out[out.length - 1];
    if (prev && isConsecutiveDuplicate(prev, step)) continue;
    out.push(step);
  }
  return out;
}

function buildStep(step: TrajectoryStep, goalSpec: GoalSpec, inputValues: Record<string, string>, policy: PolicyT): StepT {
  const action = parameterizeAction(step.action, goalSpec, inputValues);
  const mutating = matchesIrreversibleRule(action, step.target, policy);

  // Every Step requires a `target` field even for `navigate`, which
  // doesn't semantically need one and never has it resolved at replay
  // time (engine.ts skips resolve() entirely for navigate actions) — a
  // known minor schema imperfection (see REPORT.md Cuts), harmless
  // here since it's structurally inert, not silently wrong.
  const target: TargetSpecT = step.target ?? {
    fallbacks: [],
    primary: { by: "attribute", attr: "data-navigate-placeholder", value: action.type === "navigate" ? action.url : "" },
  };

  const expect: ConditionT | undefined =
    step.toolName === "type" && action.type === "type" ? { kind: "field_value_equals", target: "$self", value: action.value } : undefined;

  return {
    id: stepId(step),
    intent: step.reasoning?.trim() || `${step.toolName} action`,
    mutating,
    risk: mutating ? "irreversible" : "safe",
    action,
    target,
    ...(expect ? { expect } : {}),
    on_condition: [],
    timeout_ms: 5000,
  };
}

export interface BuildArtifactParams {
  goalSpec: GoalSpec;
  trajectory: TrajectoryStep[];
  inputValues: Record<string, string>;
  policy: PolicyT;
  model: string;
  runId: string;
  prune: boolean;
  stepsPruned: number;
}

/** Trajectory -> artifact. Throws (via ArtifactSchema.parse) if the result isn't schema-valid. */
export function buildArtifact(params: BuildArtifactParams): Artifact {
  const trajectory = params.prune ? pruneTrajectory(params.trajectory, params.goalSpec) : params.trajectory;
  const steps = trajectory.map((t) => buildStep(t, params.goalSpec, params.inputValues, params.policy));

  const outputs = params.goalSpec.outputs.map((o) => {
    const readStep = trajectory.find((t) => t.toolName === "read" && t.outputName === o.name);
    return {
      name: o.name,
      type: o.type,
      required: o.required,
      from_step: readStep ? stepId(readStep) : `(unmapped:${o.name})`,
      redact: o.redact ?? false,
    };
  });

  const riskClass = params.goalSpec.riskClass;

  const artifact = {
    schema_version: "1.0.0",
    capability: {
      id: params.goalSpec.capabilityId,
      version: "1.0.0",
      name: params.goalSpec.capabilityName,
      description: params.goalSpec.capabilityDescription,
      status: "draft",
      risk_class: riskClass,
    },
    target: {
      app_id: params.goalSpec.appId,
      surface: "web",
      entry_point: params.goalSpec.entryPoint,
      policy_ref: params.goalSpec.policyRef,
    },
    inputs: params.goalSpec.inputs.map((i) => ({
      name: i.name,
      type: i.type,
      required: i.required,
      redact: i.redact ?? false,
      example: i.example,
      ...(i.pattern ? { pattern: i.pattern } : {}),
    })),
    outputs,
    steps,
    success: {
      checkpoint: params.goalSpec.successCheckpoint,
      precondition_false: params.goalSpec.preconditionFalse,
      required_outputs: params.goalSpec.outputs.filter((o) => o.required).map((o) => o.name),
    },
    outcomes: params.goalSpec.outcomes,
    provenance: {
      discovered_at: new Date().toISOString(),
      model: params.model,
      discovery_run_id: params.runId,
      steps_pruned: params.stepsPruned,
      verified_replays: 0,
    },
  };

  return ArtifactSchema.parse(artifact);
}

export function newRunId(): string {
  return `run_${randomUUID()}`;
}
