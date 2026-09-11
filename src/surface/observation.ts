/**
 * Accessibility-tree normalisation and pruning (SPEC.md Section 4).
 *
 * Pure and Playwright-free by design: it consumes a plain tree shape
 * (`RawAriaNode`) that `web.playwright.ts` produces from
 * `page.ariaSnapshotJSON({ mode: "ai" })`, and turns it into the flat,
 * surface-neutral `ObservationNode[]` the rest of the system (discovery,
 * replay, policy) is allowed to see. Keeping this pure also makes it
 * unit-testable without a live browser.
 *
 * API note: Playwright removed `page.accessibility.snapshot()` (the API
 * SPEC.md's locked decision assumed) somewhere between 1.48 and the
 * 1.63 actually installed here. `ariaSnapshotJSON({ mode: "ai" })` is
 * the real accessibility-tree API in current Playwright — it still
 * satisfies the locked decision's intent (real AX tree, not a DOM/CSS
 * hack) and, empirically (checked live against target-app), it
 * auto-descends `<iframe>`s as nested `role: "iframe"` nodes in one
 * call, which is *better* than the assumed API for this project (no
 * manual per-frame snapshot stitching needed).
 *
 * Note on terminology: this is a different "pruning" than the one in
 * src/discovery/recorder.ts. This file prunes AX noise out of a single
 * live observation (structural container nodes with no signal — a
 * direct consequence of the target app's deliberately hostile nested
 * table layout). The recorder later prunes a whole *trajectory* of
 * steps before persisting an artifact. Same word, two different scopes.
 */
import { createHash } from "node:crypto";
import type { NodeState, ObservationNode } from "./adapter.js";

/**
 * Node shape returned by `page.ariaSnapshotJSON({ mode: "ai" })`
 * (verified empirically against the installed Playwright version —
 * see observation.test.ts fixtures). `children` mixes nested nodes and
 * bare strings (inline text fragments). `ref` is a Playwright-assigned,
 * snapshot-scoped id (e.g. "e4", "f1e6" for nodes one frame deep) — we
 * reuse it as ObservationNode.handle, but per adapter.ts's contract it
 * is never used to act; resolve() always re-locates by role/label/attribute.
 */
export interface RawAriaNode {
  role: string;
  name?: string;
  text?: string;
  children?: (RawAriaNode | string)[];
  checked?: boolean | "mixed";
  disabled?: boolean;
  expanded?: boolean;
  pressed?: boolean | "mixed";
  selected?: boolean;
  ref?: string;
}

/**
 * Roles that are always emitted regardless of content, because an
 * empty/unlabeled interactive control is still a real target a step
 * might need to resolve and act on.
 */
const INTERACTIVE_ROLES = new Set([
  "textbox",
  "searchbox",
  "button",
  "link",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "tab",
  "switch",
  "slider",
]);

function toState(node: RawAriaNode): NodeState {
  // Presence in the snapshot already implies AX-visibility: elements
  // with display:none / aria-hidden are excluded by the browser's own
  // accessibility computation before we ever see them, and
  // ariaSnapshotJSON does not report a separate visible/hidden flag.
  const state: NodeState = { visible: true };
  if (node.disabled !== undefined) state.disabled = node.disabled;
  if (node.expanded !== undefined) state.expanded = node.expanded;
  if (node.checked !== undefined) state.checked = node.checked === true;
  if (node.selected !== undefined) state.checked = node.selected; // selected reuses checked semantically for list/option roles
  return state;
}

let syntheticCounter = 0;
function syntheticHandle(framePath: string[], role: string, content: string): string {
  const key = `${framePath.join("/")}::${role}::${content}::${syntheticCounter++}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/**
 * Flatten and prune one ariaSnapshotJSON tree (already spanning all
 * frames, since mode:"ai" descends into iframes) into ObservationNodes.
 *
 * A node is emitted when it is interactive by role, OR carries its own
 * name/text, OR has more than one child (real structural multiplicity —
 * this is what distinguishes an actual data row/table from the hostile
 * layout's single-cell wrapper tables, which always have exactly one
 * child at every level by construction). Non-emitted nodes are still
 * recursed into, so real content nested inside layout noise is never lost.
 */
export function pruneAriaTree(root: RawAriaNode | RawAriaNode[]): ObservationNode[] {
  const out: ObservationNode[] = [];
  const roots = Array.isArray(root) ? root : [root];

  function visit(node: RawAriaNode, framePath: string[]): void {
    if (node.role === "iframe") {
      const nextPath = [...framePath, node.name && node.name.length > 0 ? node.name : "frame"];
      for (const child of node.children ?? []) visitChild(child, nextPath);
      return;
    }

    const content = node.text ?? node.name ?? "";
    const childCount = node.children?.length ?? 0;
    const hasState = node.checked !== undefined || node.disabled !== undefined || node.expanded !== undefined || node.selected !== undefined;
    const meaningful = INTERACTIVE_ROLES.has(node.role) || content.length > 0 || childCount > 1 || hasState;

    if (meaningful) {
      // For interactive/form roles, "no text reported" reliably means
      // "empty value" (ariaSnapshotJSON omits `text` entirely for an
      // empty input) — report it as "", not omitted, or a
      // field_value_equals check against an intentionally empty param
      // would silently fall back to comparing against the node's NAME
      // instead. For non-interactive roles (headings, rows, ...),
      // "value" genuinely doesn't apply when there's no text, so it
      // stays omitted there.
      const value = node.text !== undefined ? node.text : INTERACTIVE_ROLES.has(node.role) ? "" : undefined;
      out.push({
        role: node.role || "generic",
        name: node.name ?? "",
        ...(value !== undefined ? { value } : {}),
        state: toState(node),
        framePath,
        handle: node.ref ?? syntheticHandle(framePath, node.role, content),
      });
    }

    for (const child of node.children ?? []) visitChild(child, framePath);
  }

  function visitChild(child: RawAriaNode | string, framePath: string[]): void {
    if (typeof child === "string") {
      const text = child.trim();
      if (text.length === 0) return;
      out.push({
        role: "text",
        name: text,
        value: text,
        state: { visible: true },
        framePath,
        handle: syntheticHandle(framePath, "text", text),
      });
      return;
    }
    visit(child, framePath);
  }

  for (const r of roots) visit(r, []);
  return out;
}
