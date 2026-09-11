/**
 * The discovery loop (SPEC.md Section 4, P5, invariant #1: the model
 * proposes, it never executes). Observe -> decide -> act, same
 * SurfaceAdapter, same closed Action vocabulary, same enforce() gate
 * replay uses (invariant #2) — the only difference is who picks the
 * next action: here, an LLM; in replay, a persisted artifact.
 *
 * The model does not decide when the goal is achieved. After every
 * successful action the loop evaluates the goal spec's own
 * `successCheckpoint` (the exact same detect.ts machinery replay will
 * later use to verify the artifact) and stops the instant it's true.
 * This is deliberate: it means the discovery run and the mandatory
 * verification replay are checking the identical condition, which is
 * *why* the verification replay is expected to pass rather than being
 * a redundant afterthought.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { enforce, checkOriginAndRoute, type PolicyT } from "../policy/gate.js";
import { locate } from "../replay/locator.js";
import { evaluateCondition } from "../replay/detect.js";
import { replay } from "../replay/engine.js";
import { ArtifactSchema, findRedactedLiteralLeaks, type Artifact, type StepT, type TargetSpecT } from "../schema/artifact.js";
import type { ActionT } from "../schema/action.js";
import type { Observation, ObserveOptions, SurfaceAdapter } from "../surface/adapter.js";
import { buildSystemPrompt, buildTools, type GoalSpec } from "./prompt.js";
import { buildArtifact, newRunId, type TrajectoryStep } from "./recorder.js";

export type DiscoveryStatus = "success" | "stuck" | "max_steps_exceeded" | "max_duration_exceeded" | "policy_blocked" | "error";

export interface DiscoveryRunResult {
  status: DiscoveryStatus;
  trajectory: TrajectoryStep[];
  reason?: string;
  runId: string;
  startedAt: string;
  durationMs: number;
}

export interface DiscoveryParams {
  goalSpec: GoalSpec;
  inputValues: Record<string, string>;
  baseUrl: string;
  policy: PolicyT;
  createAdapter: (entryUrl: string) => Promise<SurfaceAdapter>;
  model?: string;
  apiKey?: string;
  runId?: string;
  /**
   * Defaults to policy.max_duration_ms, but discovery and replay have
   * fundamentally different time profiles: replay is a handful of
   * deterministic actions, discovery is many real LLM round trips.
   * Sharing one policy-level bound between them is the wrong knob —
   * this lets a caller give discovery the wall-clock room a live
   * multi-turn conversation actually needs without loosening replay's
   * (correctly tight) bound.
   */
  maxDurationMs?: number;
  /** Progress callback, primarily for CLI/evidence logging — called after every successful step. */
  onStep?: (step: TrajectoryStep) => void;
  /** Called for every rejected tool call (EDGE-29) — a malformed call, a policy block, or a resolve/act failure. */
  onRejected?: (info: { toolName: string; reasoning: string; error: string }) => void;
}

function formatObservation(observation: Observation): string {
  const nodes = observation.nodes.map((n) => ({ role: n.role, name: n.name, ...(n.value !== undefined ? { value: n.value } : {}), framePath: n.framePath }));
  return JSON.stringify(nodes);
}

export type Translated =
  | { ok: true; kind: "action"; action: ActionT; target?: TargetSpecT; outputName?: string }
  | { ok: true; kind: "stuck"; reason: string }
  | { ok: false; error: string };

/** EDGE-29: malformed or out-of-vocabulary tool calls are validated and rejected here, never silently accepted. */
/**
 * Every model-proposed target gets the goal spec's declared frame
 * scope (see GoalSpec.defaultFramePath) — without it, resolve() would
 * search only the top-level document while real content lives however
 * many iframes deep the surface actually nests it.
 */
function roleNameTarget(role: string, name: string, goalSpec: GoalSpec): TargetSpecT {
  return {
    ...(goalSpec.defaultFramePath ? { scope: { frame_path: goalSpec.defaultFramePath } } : {}),
    primary: { by: "role_name", role, name },
    fallbacks: [],
  };
}

export function translateToolCall(toolUse: Anthropic.ToolUseBlock, goalSpec: GoalSpec): Translated {
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);

  switch (toolUse.name) {
    case "report_stuck":
      return { ok: true, kind: "stuck", reason: str("reason") ?? "no reason given" };

    case "navigate": {
      const url = str("url");
      if (!url) return { ok: false, error: "navigate requires a non-empty 'url' string" };
      return { ok: true, kind: "action", action: { type: "navigate", url } };
    }

    case "click": {
      const role = str("role");
      const name = str("name");
      if (!role) return { ok: false, error: "click requires a non-empty 'role' string" };
      if (!name) return { ok: false, error: "click requires a non-empty 'name' string" };
      return { ok: true, kind: "action", action: { type: "click" }, target: roleNameTarget(role, name, goalSpec) };
    }

    case "type":
    case "select": {
      const role = str("role");
      const name = str("name");
      const value = str("value");
      if (!role) return { ok: false, error: `${toolUse.name} requires a non-empty 'role' string` };
      if (!name) return { ok: false, error: `${toolUse.name} requires a non-empty 'name' string` };
      if (value === undefined) return { ok: false, error: `${toolUse.name} requires a 'value' string` };
      return {
        ok: true,
        kind: "action",
        action: { type: toolUse.name as "type" | "select", value },
        target: roleNameTarget(role, name, goalSpec),
      };
    }

    case "read": {
      const role = str("role");
      const name = str("name");
      const outputName = str("output_name");
      if (!role) return { ok: false, error: "read requires a non-empty 'role' string" };
      if (!name) return { ok: false, error: "read requires a non-empty 'name' string" };
      if (!outputName || !goalSpec.outputs.some((o) => o.name === outputName)) {
        return { ok: false, error: `read requires 'output_name' to be one of: ${goalSpec.outputs.map((o) => o.name).join(", ")}` };
      }
      return { ok: true, kind: "action", action: { type: "read" }, target: roleNameTarget(role, name, goalSpec), outputName };
    }

    default:
      return { ok: false, error: `unknown tool '${toolUse.name}' — not part of the closed action vocabulary` };
  }
}

function describeResolution(resolution: { status: string; matchCount?: number; reason?: string }): string {
  switch (resolution.status) {
    case "not_found":
      return "no element matched that role/name — check the current observation and try a different one";
    case "ambiguous":
      return `${resolution.matchCount} elements matched that role/name — add more specific wording to 'name'`;
    case "not_interactable":
      return `element found but not interactable (${resolution.reason})`;
    default:
      return "resolution failed";
  }
}

export async function discover(params: DiscoveryParams): Promise<DiscoveryRunResult> {
  const runId = params.runId ?? newRunId();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const client = new Anthropic({ apiKey: params.apiKey ?? process.env["ANTHROPIC_API_KEY"] });
  const model = params.model ?? "claude-sonnet-5";
  const system = buildSystemPrompt(params.goalSpec, params.inputValues);
  const tools = buildTools(params.goalSpec);

  const entryUrl = new URL(params.goalSpec.entryPoint, params.baseUrl).toString();
  const adapter = await params.createAdapter(entryUrl);

  const trajectory: TrajectoryStep[] = [];
  const finish = (status: DiscoveryStatus, reason?: string): DiscoveryRunResult => ({
    status,
    trajectory,
    ...(reason ? { reason } : {}),
    runId,
    startedAt,
    durationMs: Date.now() - startedAtMs,
  });

  try {
    let observation = await adapter.observe();
    if (checkOriginAndRoute(observation.url, params.policy).decision !== "allow") {
      return finish("policy_blocked", "entry point is outside the policy allowlist");
    }

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `Current page:\n${formatObservation(observation)}` }];
    const requiredOutputs = params.goalSpec.outputs.filter((o) => o.required).map((o) => o.name);
    const capturedOutputs = new Set<string>();

    let stepIndex = 0;
    for (;;) {
      if (stepIndex >= params.policy.max_steps) return finish("max_steps_exceeded");
      if (Date.now() - startedAtMs > (params.maxDurationMs ?? params.policy.max_duration_ms)) return finish("max_duration_exceeded");

      const response = await client.messages.create({ model, max_tokens: 1024, system, tools, tool_choice: { type: "auto", disable_parallel_tool_use: true }, messages });
      messages.push({ role: "assistant", content: response.content });

      const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const reasoning = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();

      if (!toolUse) {
        messages.push({ role: "user", content: "You must call exactly one tool per turn. Choose one of the available tools." });
        stepIndex++;
        continue;
      }

      stepIndex++;
      const translated = translateToolCall(toolUse, params.goalSpec);

      if (!translated.ok) {
        params.onRejected?.({ toolName: toolUse.name, reasoning, error: translated.error });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: translated.error }] });
        continue;
      }
      if (translated.kind === "stuck") {
        return finish("stuck", translated.reason);
      }

      const { action, target, outputName } = translated;

      const liveStep: StepT = {
        id: `live_${stepIndex}`,
        intent: reasoning,
        mutating: false,
        risk: "safe",
        action,
        target: target ?? { primary: { by: "attribute", attr: "data-live-placeholder", value: "" }, fallbacks: [] },
        on_condition: [],
        timeout_ms: 5000,
      };
      const decision = enforce(action, { url: observation.url, mode: "discovery", step: liveStep }, params.policy);
      if (decision.decision !== "allow") {
        params.onRejected?.({ toolName: toolUse.name, reasoning, error: `blocked by policy: ${decision.reason}` });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: `blocked by policy: ${decision.reason}` }] });
        continue;
      }

      let capturedValue: string | undefined;
      let resolvedVia: string | undefined;

      if (action.type !== "navigate" && target) {
        const located = await locate(adapter, target, 3000);
        if (located.resolution.status !== "ok") {
          const error = describeResolution(located.resolution);
          params.onRejected?.({ toolName: toolUse.name, reasoning, error });
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: error }] });
          continue;
        }
        resolvedVia = located.resolution.resolvedVia;
      }

      const actResult = await adapter.act(action);
      if (!actResult.ok) {
        params.onRejected?.({ toolName: toolUse.name, reasoning, error: actResult.message });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, is_error: true, content: actResult.message }] });
        continue;
      }
      if (action.type === "read") capturedValue = actResult.value;

      const recordedStep: TrajectoryStep = {
        index: stepIndex,
        ...(reasoning ? { reasoning } : {}),
        toolName: toolUse.name as TrajectoryStep["toolName"],
        action,
        ...(target ? { target } : {}),
        ...(resolvedVia ? { resolvedVia } : {}),
        ...(outputName ? { outputName } : {}),
        ...(capturedValue !== undefined ? { capturedValue } : {}),
      };
      trajectory.push(recordedStep);
      params.onStep?.(recordedStep);
      if (outputName && capturedValue !== undefined) capturedOutputs.add(outputName);

      observation = await adapter.observe();
      if (checkOriginAndRoute(observation.url, params.policy).decision !== "allow") {
        return finish("policy_blocked", "navigation left the policy allowlist mid-run");
      }

      // The checkpoint alone isn't enough to stop on: it can become true
      // (e.g. simply landing on the right page) before the model has
      // actually captured every required output via a `read` action.
      // Stopping the instant the checkpoint holds would silently leave
      // outputs uncaptured — caught downstream by the verification
      // replay's missing_required_output check, but better not to rely
      // on that safety net to cover for a loop that stopped too early.
      const checkpointSatisfied = evaluateCondition(params.goalSpec.successCheckpoint, { observation, paramValues: params.inputValues });
      const missingOutputs = requiredOutputs.filter((name) => !capturedOutputs.has(name));
      if (checkpointSatisfied && missingOutputs.length === 0) {
        return finish("success");
      }

      const reminder =
        checkpointSatisfied && missingOutputs.length > 0
          ? `\n\nThe page now looks like the goal state, but you still need to capture: ${missingOutputs.join(", ")}. Use a read action for each before you are done.`
          : "";
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: `Action succeeded. Current page:\n${formatObservation(observation)}${reminder}` }],
      });
    }
  } finally {
    await adapter.close();
  }
}

// ---------------------------------------------------------------------
// Orchestrator: discover -> build -> verify -> persist (EDGE-27/EDGE-28)
// ---------------------------------------------------------------------

export interface RunDiscoveryParams extends DiscoveryParams {
  artifactsDir?: string;
}

export type RunDiscoveryOutcome =
  | { status: "persisted"; artifact: Artifact; artifactPath: string; discoveryResult: DiscoveryRunResult }
  | { status: "not_persisted"; reason: string; discoveryResult: DiscoveryRunResult };

const DEFAULT_ARTIFACTS_DIR = fileURLToPath(new URL("../../artifacts/", import.meta.url));

/**
 * [MUST] After producing a candidate artifact, immediately run the
 * replay engine against it once. Only persist if that verification
 * replay passes (EDGE-27: catches an accidentally-successful-looking
 * trajectory that doesn't actually replay deterministically). If
 * pruning caused the verification to fail, fall back to the unpruned
 * trajectory and retry once; if that also fails, persist nothing.
 */
export async function runDiscovery(params: RunDiscoveryParams): Promise<RunDiscoveryOutcome> {
  const discoveryResult = await discover(params);
  if (discoveryResult.status !== "success") {
    return { status: "not_persisted", reason: `discovery did not reach the goal: ${discoveryResult.status}${discoveryResult.reason ? ` (${discoveryResult.reason})` : ""}`, discoveryResult };
  }

  const model = params.model ?? "claude-sonnet-5";
  const attempt = async (prune: boolean): Promise<{ artifact: Artifact; verifiedReplays: number } | undefined> => {
    const unprunedCount = discoveryResult.trajectory.length;
    let artifact = buildArtifact({
      goalSpec: params.goalSpec,
      trajectory: discoveryResult.trajectory,
      inputValues: params.inputValues,
      policy: params.policy,
      model,
      runId: discoveryResult.runId,
      prune,
      stepsPruned: 0,
    });
    const stepsPruned = unprunedCount - artifact.steps.length;
    if (stepsPruned !== artifact.provenance.steps_pruned) {
      artifact = { ...artifact, provenance: { ...artifact.provenance, steps_pruned: stepsPruned } };
    }

    const verifyResult = await replay({
      artifact,
      inputs: params.inputValues,
      baseUrl: params.baseUrl,
      policy: params.policy,
      allowDraft: true,
      createAdapter: params.createAdapter,
    });
    if (verifyResult.status !== "success") return undefined;

    const verified: Artifact = {
      ...artifact,
      provenance: { ...artifact.provenance, verified_replays: 1, last_verified_at: new Date().toISOString() },
    };
    return { artifact: verified, verifiedReplays: 1 };
  };

  let result = await attempt(true);
  if (!result) result = await attempt(false);

  if (!result) {
    return { status: "not_persisted", reason: "verification replay failed for both the pruned and unpruned trajectory", discoveryResult };
  }

  const leaks = findRedactedLiteralLeaks(result.artifact, params.inputValues);
  if (leaks.length > 0) {
    return { status: "not_persisted", reason: `artifact writer refused: redacted input value(s) found as literals: ${leaks.join(", ")}`, discoveryResult };
  }

  const parsed = ArtifactSchema.safeParse(result.artifact);
  if (!parsed.success) {
    return { status: "not_persisted", reason: `built artifact failed final schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`, discoveryResult };
  }

  const artifactsDir = params.artifactsDir ?? DEFAULT_ARTIFACTS_DIR;
  const artifactPath = `${artifactsDir}${parsed.data.capability.id}.json`;
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(parsed.data, null, 2) + "\n", "utf-8");

  return { status: "persisted", artifact: parsed.data, artifactPath, discoveryResult };
}

export function loadPolicyFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}
