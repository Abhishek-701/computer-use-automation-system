import { describe, expect, it } from "vitest";
import { isEligibleForVerification, summarizeStability, type StabilitySample } from "../src/replay/stability.js";

const clean = (n: number): StabilitySample[] =>
  Array.from({ length: n }, () => ({ status: "success", warnings: { locator_drift: [], recovered_conditions: [] } }));

describe("summarizeStability", () => {
  it("tallies an all-success, no-drift batch", () => {
    const report = summarizeStability(clean(5));
    expect(report).toMatchObject({ runs: 5, successes: 5, business_outcomes: 0, failures: 0, drift_events: 0 });
  });

  it("EDGE: an all-business_outcome batch has zero successes, not a clean one", () => {
    const results: StabilitySample[] = Array.from({ length: 5 }, () => ({ status: "business_outcome" }));
    const report = summarizeStability(results);
    expect(report).toMatchObject({ runs: 5, successes: 0, business_outcomes: 5, failures: 0, drift_events: 0 });
  });

  it("collapses failed/failed_dirty/escalated into one failures count", () => {
    const results: StabilitySample[] = [{ status: "failed" }, { status: "failed_dirty" }, { status: "escalated" }, { status: "success" }];
    const report = summarizeStability(results);
    expect(report).toMatchObject({ runs: 4, successes: 1, business_outcomes: 0, failures: 3 });
  });

  it("sums locator_drift across successful runs only", () => {
    const results: StabilitySample[] = [
      { status: "success", warnings: { locator_drift: [{ step_id: "a", primary_failed: "x", resolved_via: "y" }], recovered_conditions: [] } },
      { status: "success", warnings: { locator_drift: [], recovered_conditions: [] } },
      { status: "business_outcome" }, // no warnings field at all — must not throw
    ];
    const report = summarizeStability(results);
    expect(report.drift_events).toBe(1);
  });
});

describe("isEligibleForVerification", () => {
  it("eligible: at least one success, zero failures, zero drift", () => {
    expect(isEligibleForVerification(summarizeStability(clean(3)))).toBe(true);
  });

  it("EDGE: not eligible when successes is zero, even with zero failures (the not-found-input trap)", () => {
    const allBusinessOutcome: StabilitySample[] = Array.from({ length: 5 }, () => ({ status: "business_outcome" }));
    expect(isEligibleForVerification(summarizeStability(allBusinessOutcome))).toBe(false);
  });

  it("not eligible when any run failed", () => {
    const mixed: StabilitySample[] = [...clean(4), { status: "failed" }];
    expect(isEligibleForVerification(summarizeStability(mixed))).toBe(false);
  });

  it("not eligible when locator drift occurred, even with zero failures", () => {
    const withDrift: StabilitySample[] = [
      { status: "success", warnings: { locator_drift: [{ step_id: "a", primary_failed: "x", resolved_via: "y" }], recovered_conditions: [] } },
    ];
    expect(isEligibleForVerification(summarizeStability(withDrift))).toBe(false);
  });
});
