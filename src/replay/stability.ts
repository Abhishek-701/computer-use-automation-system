/**
 * Multi-run stability scoring (stretch: "confidence & approval" +
 * "multi-run stability"). Pure — no browser, no fs — so it's unit
 * testable without booting the target app, unlike everything else in
 * `src/cli`, which has no test coverage of its own.
 *
 * Deliberately produces a report, never a decision: `capability.status`
 * only ever changes via an explicit human action (`show --promote` /
 * `--approve`), never automatically from a clean batch. See
 * src/cli/index.ts and REPORT.md §2 — the whole reason the draft gate
 * exists is so a computed score can't stand in for review.
 */
import type { ReplayResultT } from "../schema/result.js";
import type { StabilityReportT } from "../schema/artifact.js";

/** Only the fields this module actually reads — not coupled to the full result contract. */
export type StabilitySample = Pick<ReplayResultT, "status"> & { warnings?: ReplayResultT["warnings"] };

export function summarizeStability(results: readonly StabilitySample[]): StabilityReportT {
  const runs = results.length;
  const successes = results.filter((r) => r.status === "success").length;
  const business_outcomes = results.filter((r) => r.status === "business_outcome").length;
  const failures = runs - successes - business_outcomes;
  const drift_events = results.reduce((sum, r) => sum + (r.warnings?.locator_drift.length ?? 0), 0);
  return { runs, successes, business_outcomes, failures, drift_events, checked_at: new Date().toISOString() };
}

/**
 * Evidence-based *eligibility* for a draft -> verified promotion — not
 * the promotion itself. Requires at least one genuine success, not just
 * an absence of failures: a batch run entirely against a not-found input
 * reports `business_outcomes: N, successes: 0, failures: 0` and must not
 * read as "reliable" — repeatable is not the same as working.
 */
export function isEligibleForVerification(report: StabilityReportT): boolean {
  return report.successes >= 1 && report.failures === 0 && report.drift_events === 0;
}
