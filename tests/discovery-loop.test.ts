/**
 * Pure unit tests for translateToolCall (EDGE-29: malformed or
 * out-of-vocabulary tool calls are validated and rejected). No browser,
 * no LLM — these test the deterministic validation logic around the
 * real, one-time live discovery run's LLM interaction, not the LLM
 * itself. See evidence/discovery/ for the real run this logic was
 * exercised by, including a genuine rejection it recovered from.
 */
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { translateToolCall } from "../src/discovery/loop.js";
import type { GoalSpec } from "../src/discovery/prompt.js";

const goalSpec: GoalSpec = {
  goal: "Look up member 10001 and read their savings balance",
  capabilityId: "member.savings_balance.lookup",
  capabilityName: "Look up member savings balance",
  capabilityDescription: "Given a member ID, returns the current savings balance.",
  appId: "target-app-hostile-core-banking",
  entryPoint: "/members/search",
  policyRef: "src/policy/policy.default.json",
  riskClass: "read_only",
  defaultFramePath: ["shell", "content"],
  inputs: [{ name: "member_id", type: "string", required: true, redact: true, example: "10001" }],
  outputs: [{ name: "savings_balance", type: "money", required: true }],
  successCheckpoint: { kind: "element_visible", target: { by: "role_name", role: "heading", name: "Account summary" } },
  preconditionFalse: true,
  outcomes: [],
};

function toolUse(name: string, input: unknown): Anthropic.ToolUseBlock {
  return { id: "tu_1", type: "tool_use", name, input };
}

describe("translateToolCall (EDGE-29)", () => {
  it("translates a valid click into an action + role_name target with the goal spec's frame scope", () => {
    const result = translateToolCall(toolUse("click", { role: "button", name: "Search" }), goalSpec);
    expect(result).toEqual({
      ok: true,
      kind: "action",
      action: { type: "click" },
      target: { scope: { frame_path: ["shell", "content"] }, primary: { by: "role_name", role: "button", name: "Search" }, fallbacks: [] },
    });
  });

  it("translates a valid type with a value", () => {
    const result = translateToolCall(toolUse("type", { role: "textbox", name: "Member ID", value: "10001" }), goalSpec);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "action") {
      expect(result.action).toEqual({ type: "type", value: "10001" });
    }
  });

  it("translates a valid read tagged with a declared output_name", () => {
    const result = translateToolCall(toolUse("read", { role: "textbox", name: "Savings", output_name: "savings_balance" }), goalSpec);
    expect(result.ok).toBe(true);
    if (result.ok && result.kind === "action") {
      expect(result.outputName).toBe("savings_balance");
    }
  });

  it("rejects a click missing 'name'", () => {
    const result = translateToolCall(toolUse("click", { role: "button" }), goalSpec);
    expect(result).toEqual({ ok: false, error: "click requires a non-empty 'name' string" });
  });

  it("rejects a read whose output_name isn't declared", () => {
    const result = translateToolCall(toolUse("read", { role: "textbox", name: "Notes", output_name: "not_a_real_output" }), goalSpec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("savings_balance");
  });

  it("rejects an unknown tool name — not part of the closed action vocabulary", () => {
    const result = translateToolCall(toolUse("delete_everything", { role: "button", name: "Confirm" }), goalSpec);
    expect(result).toEqual({ ok: false, error: "unknown tool 'delete_everything' — not part of the closed action vocabulary" });
  });

  it("translates report_stuck into a stuck signal, not an action", () => {
    const result = translateToolCall(toolUse("report_stuck", { reason: "cannot find the field" }), goalSpec);
    expect(result).toEqual({ ok: true, kind: "stuck", reason: "cannot find the field" });
  });

  it("rejects navigate with a non-string url", () => {
    const result = translateToolCall(toolUse("navigate", { url: 12345 }), goalSpec);
    expect(result).toEqual({ ok: false, error: "navigate requires a non-empty 'url' string" });
  });
});
