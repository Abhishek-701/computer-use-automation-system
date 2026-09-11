/**
 * Generic matcher for declared Conditions (SPEC.md Section 3, REPORT.md
 * Section 3's design argument): detectors are declared data evaluated
 * here, not app-specific code, which is what keeps the replay engine
 * app-agnostic and detectors tenant-overridable. Shared by three
 * callers with three different names for the same mechanism — a
 * step's `expect`, the artifact's `success.checkpoint`, and every
 * `outcomes[].detector` — they are all just a Condition evaluated
 * against an Observation.
 *
 * Pure and Playwright-free (invariant #2): operates only on the
 * surface-neutral Observation type from src/surface/adapter.ts.
 *
 * Scope limitation, stated plainly: matching a Condition's `target`
 * against a *flat* Observation only makes sense for `role_name` and
 * `label_text` locators (both resolve to a name/role comparison over
 * the whole node list). `attribute` and `scoped_position` locators are
 * valid for a Step's own live *targeting* (src/surface/web.playwright.ts
 * resolves those against the real nested DOM/AX tree, which has the
 * containment structure a flat list threw away) but cannot be
 * evaluated as a *condition* target here — this throws a clear error
 * rather than silently matching nothing. No condition in this project
 * needs them.
 */
import type { Observation, ObservationNode } from "../surface/adapter.js";
import type { ConditionT, LocatorT } from "../schema/artifact.js";
import type { ParamOrLiteralT } from "../schema/action.js";

export interface DetectContext {
  observation: Observation;
  /** The node the current step most recently acted on, for `"$self"` targets (EDGE-16). */
  selfNode?: ObservationNode;
  paramValues: Record<string, string>;
}

function literalOf(value: ParamOrLiteralT, paramValues: Record<string, string>): string {
  if (typeof value === "string") return value;
  const v = paramValues[value.$param];
  if (v === undefined) throw new Error(`unbound parameter in condition: ${value.$param}`);
  return v;
}

/**
 * Exported for assert.ts, which needs to re-derive "$self" (the step's
 * own target) fresh from each poll's observation — the node a step
 * acted on a moment ago is a different object in the next observation,
 * even for the same element.
 */
export function findMatchingNodes(target: LocatorT, observation: Observation): ObservationNode[] {
  switch (target.by) {
    case "role_name":
      return observation.nodes.filter((n) => n.role === target.role && (!target.name || n.name === target.name));
    case "label_text":
      return observation.nodes.filter((n) => n.name === target.text);
    case "attribute":
    case "scoped_position":
      throw new Error(
        `condition target locator '${target.by}' is not supported for detection against a flat observation — use role_name or label_text`,
      );
  }
}

function resolveTarget(target: "$self" | LocatorT, ctx: DetectContext): ObservationNode[] {
  if (target === "$self") return ctx.selfNode ? [ctx.selfNode] : [];
  return findMatchingNodes(target, ctx.observation);
}

/** A node's comparable text: its captured value if present, else its accessible name. */
function textOf(node: ObservationNode): string {
  return node.value ?? node.name;
}

export function evaluateCondition(condition: ConditionT, ctx: DetectContext): boolean {
  if (condition.kind === "all") {
    return condition.of.every((c) => evaluateCondition(c, ctx));
  }

  switch (condition.kind) {
    case "text_present": {
      const re = new RegExp(condition.pattern);
      return ctx.observation.nodes.some((n) => re.test(textOf(n)));
    }
    case "element_visible": {
      const nodes = resolveTarget(condition.target, ctx);
      return nodes.some((n) => n.state.visible);
    }
    case "element_count_gt": {
      const nodes = resolveTarget(condition.target, ctx);
      return nodes.length > condition.count;
    }
    case "text_matches": {
      const nodes = resolveTarget(condition.target, ctx);
      const re = new RegExp(condition.pattern);
      return nodes.some((n) => re.test(textOf(n)));
    }
    case "field_value_equals": {
      const nodes = resolveTarget(condition.target, ctx);
      const expected = literalOf(condition.value, ctx.paramValues);
      return nodes.some((n) => textOf(n) === expected);
    }
  }
}
