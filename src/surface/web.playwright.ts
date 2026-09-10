/**
 * The one real SurfaceAdapter implementation (SPEC.md Section 4, P2).
 * This is the ONLY file in the project allowed to import Playwright —
 * that boundary is enforced by convention here and checked by grep in
 * CI/tests (`page.` / `locator(` must never appear in src/replay,
 * src/discovery, or src/policy).
 *
 * resolve() / act() split: `resolve(target)` locates a fresh Playwright
 * Locator for a TargetSpec and, on success, remembers it as
 * `lastLocator`; `act(action)` performs click/type/select/read against
 * whatever was last resolved. `navigate` is the one action that needs
 * no prior resolve(). This two-step "aim, then fire" matches the
 * SurfaceAdapter interface exactly as SPEC.md Section 5 fixes it
 * (`act(action: Action)` takes no target parameter).
 */
import { chromium, type Browser, type FrameLocator, type Locator, type Page } from "playwright";
import type { ActionT, ParamOrLiteralT } from "../schema/action.js";
import type { LocatorT, TargetSpecT } from "../schema/artifact.js";
import type { ActionResult, ObserveOptions, Observation, Resolution, SurfaceAdapter } from "./adapter.js";
import { pruneAriaTree, type RawAriaNode } from "./observation.js";

type Scope = Page | FrameLocator;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyActionError(err: unknown): string {
  const msg = errMsg(err);
  if (/detached/i.test(msg)) return "frame_detached";
  if (/Timeout/i.test(msg)) return "action_timeout";
  return "action_failed";
}

/** CSS attribute-value escaping (quotes only — locator strategy uses simple attr selectors). */
function escapeAttrValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function buildLocator(scope: Scope, loc: LocatorT): Locator {
  switch (loc.by) {
    case "role_name":
      // Schema roles are free-form (any AX role the target app exposes); Playwright's
      // getByRole type is a fixed literal union. Widen at this one boundary only.
      return scope.getByRole(loc.role as Parameters<Scope["getByRole"]>[0], loc.name ? { name: loc.name } : {});
    case "label_text":
      return scope.getByLabel(loc.text);
    case "attribute":
      return scope.locator(`[${loc.attr}="${escapeAttrValue(loc.value)}"]`);
    case "scoped_position":
      return scope
        .getByRole(loc.container_role as Parameters<Scope["getByRole"]>[0], { name: loc.container_name })
        .getByRole(loc.role as Parameters<Scope["getByRole"]>[0])
        .nth(loc.index);
  }
}

/**
 * Descend `depth` iframe levels. Frame path entries are documentary
 * labels only (see artifacts/member.savings_balance.lookup.json) —
 * resolution is positional, always the first iframe at each level.
 * Correct for this project's target app (exactly one iframe per
 * nesting level); a frameset with multiple sibling frames at one level
 * would need frame_path entries to carry real selectors instead. Named
 * as a known limitation, not silently assumed away.
 */
function frameScope(page: Page, framePath?: string[]): Scope {
  let scope: Scope = page;
  const depth = framePath?.length ?? 0;
  for (let i = 0; i < depth; i++) {
    scope = scope.frameLocator("iframe").first();
  }
  return scope;
}

function literalValue(value: ParamOrLiteralT): string {
  if (typeof value === "string") return value;
  throw new Error(`unsubstituted $param reference reached the adapter: ${value.$param}`);
}

export class PlaywrightWebAdapter implements SurfaceAdapter {
  private lastLocator: Locator | null = null;

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  static async create(entryUrl: string, opts: { headless?: boolean } = {}): Promise<PlaywrightWebAdapter> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const page = await browser.newPage();
    const adapter = new PlaywrightWebAdapter(browser, page, new URL(entryUrl).origin);
    await page.goto(entryUrl, { waitUntil: "load" });
    return adapter;
  }

  async observe(options?: ObserveOptions): Promise<Observation> {
    const raw = (await this.page.ariaSnapshotJSON({ mode: "ai" })) as RawAriaNode | RawAriaNode[];
    const nodes = pruneAriaTree(raw);
    const observation: Observation = { url: this.page.url(), nodes };
    if (options?.screenshot) {
      observation.screenshot = await this.page.screenshot();
    }
    return observation;
  }

  async resolve(target: TargetSpecT): Promise<Resolution> {
    const scope = frameScope(this.page, target.scope?.frame_path);
    const candidates: { loc: LocatorT; label: string }[] = [
      { loc: target.primary, label: "primary" },
      ...target.fallbacks.map((f: LocatorT, i: number) => ({ loc: f, label: `fallbacks[${i}]` })),
    ];

    // Try each candidate in order; the first clean single-interactable
    // match wins immediately (EDGE-06: never take the first match among
    // several — a >1 count is never treated as a hit). If none succeed,
    // return the most informative conclusion seen (ambiguous or
    // not_interactable take priority over a bare not_found), so the
    // caller learns *why* resolution failed, not just that it did.
    let fallbackConclusion: Resolution | null = null;

    for (const candidate of candidates) {
      const locator = buildLocator(scope, candidate.loc);
      const count = await locator.count();

      if (count === 0) continue;

      if (count > 1) {
        fallbackConclusion ??= { status: "ambiguous", matchCount: count };
        continue;
      }

      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        fallbackConclusion ??= { status: "not_interactable", reason: "hidden" };
        continue;
      }
      const enabled = await locator.isEnabled().catch(() => true);
      if (!enabled) {
        fallbackConclusion ??= { status: "not_interactable", reason: "disabled" };
        continue;
      }

      this.lastLocator = locator;
      return { status: "ok", resolvedVia: candidate.label };
    }

    return fallbackConclusion ?? { status: "not_found" };
  }

  async act(action: ActionT): Promise<ActionResult> {
    if (action.type === "navigate") {
      try {
        const url = /^https?:\/\//.test(action.url) ? action.url : new URL(action.url, this.baseUrl).toString();
        await this.page.goto(url, { waitUntil: "load" });
        return { ok: true };
      } catch (err) {
        return { ok: false, errorClass: "navigation_failed", message: errMsg(err) };
      }
    }

    if (!this.lastLocator) {
      return {
        ok: false,
        errorClass: "no_resolved_target",
        message: `act(${action.type}) called with no prior successful resolve()`,
      };
    }
    const locator = this.lastLocator;

    try {
      switch (action.type) {
        case "click":
          await locator.click({ timeout: 5000 });
          return { ok: true };
        case "type":
          await locator.fill(literalValue(action.value), { timeout: 5000 });
          return { ok: true };
        case "select":
          await locator.selectOption(literalValue(action.value), { timeout: 5000 });
          return { ok: true };
        case "read": {
          let value: string;
          try {
            value = await locator.inputValue({ timeout: 1000 });
          } catch {
            value = (await locator.textContent()) ?? "";
          }
          return { ok: true, value: value.trim() };
        }
        default: {
          const exhaustive: never = action;
          throw new Error(`unreachable action type: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (err) {
      return { ok: false, errorClass: classifyActionError(err), message: errMsg(err) };
    }
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
