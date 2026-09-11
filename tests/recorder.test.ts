/**
 * Pure unit tests for src/discovery/recorder.ts — no browser, no LLM.
 * Covers EDGE-01 (parameterisation), EDGE-02 (route canonicalisation),
 * EDGE-03 (only action values get substituted), and the pruning
 * strategy (unmapped/duplicate reads, consecutive duplicate actions).
 */
import { describe, expect, it } from "vitest";
import { buildArtifact, canonicalizeRoute, pruneTrajectory, type TrajectoryStep } from "../src/discovery/recorder.js";
import type { GoalSpec } from "../src/discovery/prompt.js";
import { loadPolicy, type PolicyT } from "../src/policy/gate.js";
import { readFileSync } from "node:fs";

const rawPolicy = JSON.parse(readFileSync(new URL("../src/policy/policy.default.json", import.meta.url), "utf-8"));
const policy: PolicyT = loadPolicy(rawPolicy);

const goalSpec: GoalSpec = {
  goal: "Look up member 10001 and read their savings balance",
  capabilityId: "member.savings_balance.lookup",
  capabilityName: "Look up member savings balance",
  capabilityDescription: "Given a member ID, returns the current savings balance.",
  appId: "target-app-hostile-core-banking",
  entryPoint: "/members/search",
  policyRef: "src/policy/policy.default.json",
  riskClass: "read_only",
  inputs: [{ name: "member_id", type: "string", required: true, redact: true, example: "10001" }],
  outputs: [{ name: "savings_balance", type: "money", required: true }],
  successCheckpoint: { kind: "element_visible", target: { by: "role_name", role: "heading", name: "Account summary" } },
  preconditionFalse: true,
  outcomes: [],
};

const inputValues = { member_id: "10001" };

function step(partial: Partial<TrajectoryStep> & Pick<TrajectoryStep, "index" | "toolName" | "action">): TrajectoryStep {
  return partial;
}

describe("canonicalizeRoute (EDGE-02)", () => {
  it("replaces a literal input value in a URL path with a route placeholder", () => {
    expect(canonicalizeRoute("/member/10001/accounts", goalSpec.inputs, inputValues)).toBe("/member/{member_id}/accounts");
  });

  it("leaves a URL with no matching literal unchanged", () => {
    expect(canonicalizeRoute("/members/search", goalSpec.inputs, inputValues)).toBe("/members/search");
  });
});

describe("pruneTrajectory", () => {
  it("drops a read step not mapped to any declared output", () => {
    const trajectory: TrajectoryStep[] = [
      step({ index: 1, toolName: "read", action: { type: "read" }, outputName: "unmapped_thing", capturedValue: "whatever" }),
      step({ index: 2, toolName: "read", action: { type: "read" }, outputName: "savings_balance", capturedValue: "$4,231.10" }),
    ];
    const pruned = pruneTrajectory(trajectory, goalSpec);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]?.outputName).toBe("savings_balance");
  });

  it("drops a duplicate read of an output already captured", () => {
    const trajectory: TrajectoryStep[] = [
      step({ index: 1, toolName: "read", action: { type: "read" }, outputName: "savings_balance", capturedValue: "$4,231.10" }),
      step({ index: 2, toolName: "read", action: { type: "read" }, outputName: "savings_balance", capturedValue: "$4,231.10" }),
    ];
    expect(pruneTrajectory(trajectory, goalSpec)).toHaveLength(1);
  });

  it("drops a consecutive exact-duplicate action", () => {
    const clickSearch: TrajectoryStep = {
      index: 1,
      toolName: "click",
      action: { type: "click" },
      target: { primary: { by: "role_name", role: "button", name: "Search" }, fallbacks: [] },
    };
    const trajectory: TrajectoryStep[] = [clickSearch, { ...clickSearch, index: 2 }];
    expect(pruneTrajectory(trajectory, goalSpec)).toHaveLength(1);
  });

  it("keeps non-duplicate, output-mapped steps untouched", () => {
    const trajectory: TrajectoryStep[] = [
      step({
        index: 1,
        toolName: "type",
        action: { type: "type", value: "10001" },
        target: { primary: { by: "role_name", role: "textbox", name: "Member ID" }, fallbacks: [] },
      }),
      step({
        index: 2,
        toolName: "click",
        action: { type: "click" },
        target: { primary: { by: "role_name", role: "button", name: "Search" }, fallbacks: [] },
      }),
      step({
        index: 3,
        toolName: "read",
        action: { type: "read" },
        target: { primary: { by: "role_name", role: "textbox", name: "Savings" }, fallbacks: [] },
        outputName: "savings_balance",
        capturedValue: "$4,231.10",
      }),
    ];
    expect(pruneTrajectory(trajectory, goalSpec)).toHaveLength(3);
  });
});

describe("buildArtifact", () => {
  const trajectory: TrajectoryStep[] = [
    {
      index: 1,
      reasoning: "Type the member id into the search field.",
      toolName: "type",
      action: { type: "type", value: "10001" },
      target: { primary: { by: "role_name", role: "textbox", name: "Member ID" }, fallbacks: [] },
    },
    {
      index: 2,
      reasoning: "Submit the search.",
      toolName: "click",
      action: { type: "click" },
      target: { primary: { by: "role_name", role: "button", name: "Search" }, fallbacks: [] },
    },
    {
      index: 3,
      reasoning: "Read the savings balance.",
      toolName: "read",
      action: { type: "read" },
      target: { primary: { by: "role_name", role: "textbox", name: "Savings" }, fallbacks: [] },
      outputName: "savings_balance",
      capturedValue: "$4,231.10",
    },
  ];

  it("EDGE-01: substitutes the literal input value with a $param reference in action.value only", () => {
    const artifact = buildArtifact({ goalSpec, trajectory, inputValues, policy, model: "claude-sonnet-5", runId: "run_test", prune: true, stepsPruned: 0 });
    const typeStep = artifact.steps.find((s) => s.id.startsWith("type_"));
    expect(typeStep?.action).toEqual({ type: "type", value: { $param: "member_id" } });
    // EDGE-03: the same-derived expect value also gets the $param form (it's derived FROM the parameter, not observed text).
    expect(typeStep?.expect).toEqual({ kind: "field_value_equals", target: "$self", value: { $param: "member_id" } });
  });

  it("maps a declared output to the step that captured it, via from_step", () => {
    const artifact = buildArtifact({ goalSpec, trajectory, inputValues, policy, model: "claude-sonnet-5", runId: "run_test", prune: true, stepsPruned: 0 });
    const output = artifact.outputs.find((o) => o.name === "savings_balance");
    expect(output?.from_step).toBe("read_3");
    expect(artifact.steps.find((s) => s.id === "read_3")).toBeDefined();
  });

  it("classifies mutating/risk from the policy's irreversible_actions rules, not a guess", () => {
    const mutatingTrajectory: TrajectoryStep[] = [
      {
        index: 1,
        toolName: "click",
        action: { type: "click" },
        target: { primary: { by: "role_name", role: "button", name: "Confirm" }, fallbacks: [] },
      },
    ];
    const artifact = buildArtifact({
      goalSpec: { ...goalSpec, outputs: [] },
      trajectory: mutatingTrajectory,
      inputValues,
      policy,
      model: "claude-sonnet-5",
      runId: "run_test",
      prune: false,
      stepsPruned: 0,
    });
    expect(artifact.steps[0]?.mutating).toBe(true);
    expect(artifact.steps[0]?.risk).toBe("irreversible");

    const safeArtifact = buildArtifact({
      goalSpec: { ...goalSpec, outputs: [] },
      trajectory: [{ ...mutatingTrajectory[0]!, target: { primary: { by: "role_name", role: "button", name: "Search" }, fallbacks: [] } }],
      inputValues,
      policy,
      model: "claude-sonnet-5",
      runId: "run_test",
      prune: false,
      stepsPruned: 0,
    });
    expect(safeArtifact.steps[0]?.mutating).toBe(false);
    expect(safeArtifact.steps[0]?.risk).toBe("safe");
  });

  it("produces a fully schema-valid artifact end to end", () => {
    // buildArtifact already calls ArtifactSchema.parse internally and
    // would throw on an invalid shape — reaching this line is the proof.
    expect(() =>
      buildArtifact({ goalSpec, trajectory, inputValues, policy, model: "claude-sonnet-5", runId: "run_test", prune: true, stepsPruned: 0 }),
    ).not.toThrow();
  });
});
