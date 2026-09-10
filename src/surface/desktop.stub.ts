/**
 * Interface-satisfying stub proving the SurfaceAdapter seam extends to
 * a desktop surface (SPEC.md Section 4, P2; brief Section 3.7). Not a
 * second real implementation — SPEC.md's anti-goals are explicit that
 * building one doesn't prove anything more within the time box. This
 * proves the *seam*: replay and discovery are written against
 * SurfaceAdapter, not against Playwright, so this file compiling and
 * satisfying the interface is the actual evidence, not its bodies.
 *
 * Real desktop implementation would swap `ariaSnapshotJSON` for an
 * OS-level accessibility API (UI Automation on Windows, AXAPI on
 * macOS) — both expose the same role/name/value/state shape
 * `Observation` already models, which is why this seam holds. See
 * REPORT.md Section 4 for the full heterogeneity argument.
 */
import type { ActionT } from "../schema/action.js";
import type { TargetSpecT } from "../schema/artifact.js";
import { NotImplementedError, type ActionResult, type ObserveOptions, type Observation, type Resolution, type SurfaceAdapter } from "./adapter.js";

const SURFACE = "desktop";

export class DesktopStubAdapter implements SurfaceAdapter {
  async observe(_options?: ObserveOptions): Promise<Observation> {
    throw new NotImplementedError(SURFACE, "observe");
  }

  async act(_action: ActionT): Promise<ActionResult> {
    throw new NotImplementedError(SURFACE, "act");
  }

  async resolve(_target: TargetSpecT): Promise<Resolution> {
    throw new NotImplementedError(SURFACE, "resolve");
  }

  async close(): Promise<void> {
    // Nothing was ever opened; closing a never-opened stub is a no-op success.
  }
}
