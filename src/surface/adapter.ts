/**
 * SurfaceAdapter (SPEC.md Section 5 P2, invariant #2). This is the ONLY
 * shape discovery and replay know about — a web app today, a legacy
 * frameset app or a desktop app tomorrow, without either engine
 * changing. Discovery and replay share one adapter, one action
 * vocabulary (src/schema/action.ts), one gate; they differ only in who
 * selects the next action.
 *
 * Structural invariant this file exists to protect: no Playwright type
 * may appear above src/surface/. Nothing in this file imports Playwright.
 * `Observation` is deliberately surface-neutral — no HTML, no CSS
 * selectors, no coordinates — so the same replay engine and discovery
 * loop would work unmodified against a desktop adapter.
 */
import type { ActionT } from "../schema/action.js";
import type { TargetSpecT } from "../schema/artifact.js";

/** Normalized element state — a small, surface-neutral bag, not a raw DOM/AX dump. */
export interface NodeState {
  visible: boolean;
  disabled?: boolean;
  readonly?: boolean;
  checked?: boolean;
  expanded?: boolean;
  focused?: boolean;
}

/**
 * One perceived element. `handle` is an opaque, observation-scoped
 * identity string (stable within one `observe()` call, used for
 * stuck-detection hashing and logging) — it is NOT a live reference an
 * adapter can act on later. Acting always goes through `resolve()`,
 * which re-locates the element fresh. This is a deliberate consequence
 * of using the real accessibility-tree snapshot API (SPEC.md Section 3
 * locked decision): the browser's AX snapshot is a value, not a set of
 * clickable references.
 */
export interface ObservationNode {
  role: string;
  name: string;
  value?: string;
  state: NodeState;
  framePath: string[];
  handle: string;
}

export interface Observation {
  url: string;
  nodes: ObservationNode[];
  /** Present only when the caller asked for one (observe({ screenshot: true })). */
  screenshot?: Buffer;
}

export type ActionResult =
  | { ok: true; value?: string }
  | { ok: false; errorClass: string; message: string };

/**
 * Outcome of resolving a TargetSpec to a concrete, actionable element.
 * EDGE-06: `ambiguous` is a hard failure, never "take the first match".
 * EDGE-07: `not_interactable` (covered/disabled/hidden) is distinct
 * from `not_found` — the element exists, acting on it right now would not work.
 */
export type Resolution =
  | { status: "ok"; resolvedVia: string }
  | { status: "not_found" }
  | { status: "ambiguous"; matchCount: number }
  | { status: "not_interactable"; reason: string };

export interface ObserveOptions {
  screenshot?: boolean;
}

export interface SurfaceAdapter {
  observe(options?: ObserveOptions): Promise<Observation>;
  /**
   * Perform an action. For `click`/`type`/`select`/`read`, this acts on
   * whatever `resolve()` most recently located — resolve() is "aim",
   * act() is "fire", matching the interface SPEC.md Section 5 fixes.
   * `navigate` is self-contained and does not require a prior resolve().
   */
  act(action: ActionT): Promise<ActionResult>;
  resolve(target: TargetSpecT): Promise<Resolution>;
  close(): Promise<void>;
}

export class NotImplementedError extends Error {
  constructor(surface: string, method: string) {
    super(`${method}() is not implemented for the ${surface} surface`);
    this.name = "NotImplementedError";
  }
}
