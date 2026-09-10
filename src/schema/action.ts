/**
 * The closed Action vocabulary (SPEC.md invariant #1 and #2, Section 4).
 *
 * Shared by discovery and replay: the LLM's tool-calling loop can only
 * ever emit one of these shapes, and the persisted artifact's steps can
 * only ever contain one of these shapes. Neither the model nor a replay
 * step can "reach" the surface adapter through anything else — this is
 * what keeps prompt-injection blast radius bounded by policy rather than
 * by model judgment (SPEC.md EDGE-26).
 *
 * Five action types cover the whole target-app flow: `navigate` moves
 * between screens directly, `click` activates a control, `type` and
 * `select` write into a field, `read` captures a field's value/text
 * without mutating anything (this is how an artifact's `outputs[].from_step`
 * ties back to a concrete action). There is deliberately no `wait`: waits
 * are on conditions only, decided by the replay/discovery engine, never
 * a wall-clock action a step can request (SPEC.md EDGE-11).
 *
 * `target` (which element an action acts on) is NOT part of Action — it
 * is a sibling field on Step (see artifact.ts), matching SPEC.md
 * Section 6's own worked example. `navigate` is the one exception: it is
 * self-contained, since it addresses a URL, not an element.
 */
import { z } from "zod";

/** A reference to an artifact input parameter, e.g. `{ "$param": "member_id" }`. */
export const ParamRef = z
  .object({
    $param: z.string().min(1),
  })
  .strict();
export type ParamRefT = z.infer<typeof ParamRef>;

/**
 * A value that is either a literal string or a parameter reference.
 * Used by `type`/`select` actions and, in artifact.ts, by conditions
 * whose value was itself derived from a parameter (SPEC.md EDGE-03).
 */
export const ParamOrLiteral = z.union([z.string(), ParamRef]);
export type ParamOrLiteralT = z.infer<typeof ParamOrLiteral>;

const NavigateAction = z
  .object({
    type: z.literal("navigate"),
    /**
     * May contain `{param_name}` route placeholders, canonicalised from
     * a concrete discovery-time URL (SPEC.md EDGE-02), e.g.
     * "/member/{member_id}/accounts". This is a distinct substitution
     * mechanism from ParamRef — it applies to path segments, not to a
     * whole field value.
     */
    url: z.string().min(1),
  })
  .strict();

const ClickAction = z
  .object({
    type: z.literal("click"),
  })
  .strict();

const TypeAction = z
  .object({
    type: z.literal("type"),
    value: ParamOrLiteral,
  })
  .strict();

const SelectAction = z
  .object({
    type: z.literal("select"),
    value: ParamOrLiteral,
  })
  .strict();

/** Captures a target's observed value/text without mutating it. */
const ReadAction = z
  .object({
    type: z.literal("read"),
  })
  .strict();

export const Action = z.discriminatedUnion("type", [
  NavigateAction,
  ClickAction,
  TypeAction,
  SelectAction,
  ReadAction,
]);
export type ActionT = z.infer<typeof Action>;

export const ACTION_TYPES = ["navigate", "click", "type", "select", "read"] as const;
