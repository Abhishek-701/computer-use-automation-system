/**
 * P1 acceptance criterion (SPEC.md Section 5): the hand-written
 * member-lookup example artifact validates, and a deliberately malformed
 * one is rejected with a readable error. Also covers EDGE-21 (artifact
 * writer refuses a literal matching a redacted input value), since the
 * check lives in this same file (artifact.ts) and is cheap to prove now.
 *
 * This is not yet the curated 5-8 golden invariant suite from SPEC.md
 * Section 12 — that's assembled at CP8 once policy/replay/writer exist.
 * This file proves CP2's own acceptance criterion.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArtifactSchema, findRedactedLiteralLeaks, parseArtifact } from "../src/schema/artifact.js";
import { parseReplayResult } from "../src/schema/result.js";

const EXAMPLE_PATH = new URL("../artifacts/member.savings_balance.lookup.json", import.meta.url);

function loadExample(): unknown {
  return JSON.parse(readFileSync(EXAMPLE_PATH, "utf-8"));
}

describe("artifact schema", () => {
  it("validates the hand-written member-lookup example", () => {
    const result = parseArtifact(loadExample());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.capability.id).toBe("member.savings_balance.lookup");
      expect(result.artifact.steps.map((s) => s.id)).toEqual([
        "enter_member_id",
        "submit_search",
        "read_balance",
      ]);
    }
  });

  it("rejects a malformed artifact with a readable error path", () => {
    const malformed = loadExample() as Record<string, unknown>;
    // Corrupt two things at once: bad semver, and drop a required field.
    (malformed["capability"] as Record<string, unknown>)["version"] = "not-a-semver";
    delete (malformed["target"] as Record<string, unknown>)["entry_point"];

    const result = parseArtifact(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("capability.version:"))).toBe(true);
      expect(result.errors.some((e) => e.startsWith("target.entry_point:"))).toBe(true);
    }
  });

  it("rejects an out-of-vocabulary action type", () => {
    const malformed = loadExample() as { steps: Array<{ action: Record<string, unknown> }> };
    malformed.steps[0]!.action = { type: "double_click" };
    const result = parseArtifact(malformed);
    expect(result.ok).toBe(false);
  });

  it("EDGE-21: flags a literal matching a redacted input's value in steps", () => {
    const artifact = ArtifactSchema.parse(loadExample());
    // Baseline: the example only ever references member_id via $param, so no leak.
    expect(findRedactedLiteralLeaks(artifact, { member_id: "10001" })).toEqual([]);

    // Simulate a recorder bug: a literal value slipped into a step instead of a $param ref.
    const leaky = structuredClone(artifact);
    leaky.steps[0]!.action = { type: "type", value: "10001" };
    expect(findRedactedLiteralLeaks(leaky, { member_id: "10001" })).toEqual(["10001"]);
  });

  it("does not flag inputs[].example as a leak (author-declared, not captured)", () => {
    const artifact = ArtifactSchema.parse(loadExample());
    // example is "10001", same as the redacted input value used at runtime here —
    // this must not be flagged, since it's documentation, not a captured literal.
    expect(artifact.inputs[0]!.example).toBe("10001");
    expect(findRedactedLiteralLeaks(artifact, { member_id: "10001" })).toEqual([]);
  });
});

describe("replay result contract", () => {
  it("accepts a well-formed business_outcome result", () => {
    const result = parseReplayResult({
      status: "business_outcome",
      capability_id: "member.savings_balance.lookup",
      capability_version: "1.0.0",
      run_id: "run_1",
      started_at: "2026-09-10T00:00:00.000Z",
      duration_ms: 120,
      outputs: {},
      outcome: { code: "member_not_found", detected_at_step: "submit_search" },
      evidence: { log: "evidence/run_1/log.jsonl" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects business_outcome status with no outcome payload", () => {
    const result = parseReplayResult({
      status: "business_outcome",
      capability_id: "member.savings_balance.lookup",
      capability_version: "1.0.0",
      run_id: "run_1",
      started_at: "2026-09-10T00:00:00.000Z",
      duration_ms: 120,
      outputs: {},
      evidence: { log: "evidence/run_1/log.jsonl" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("outcome:"))).toBe(true);
    }
  });
});
