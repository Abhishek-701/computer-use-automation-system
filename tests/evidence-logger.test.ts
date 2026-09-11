import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceLogger, redactedFieldsFromArtifact } from "../src/evidence/logger.js";
import { loadPolicy, type PolicyT } from "../src/policy/gate.js";
import { ArtifactSchema } from "../src/schema/artifact.js";

const rawPolicy = JSON.parse(readFileSync(new URL("../src/policy/policy.default.json", import.meta.url), "utf-8"));
const policy: PolicyT = loadPolicy(rawPolicy);

const rawArtifact = JSON.parse(readFileSync(new URL("./fixtures/hand-written-member-lookup.json", import.meta.url), "utf-8"));
const artifact = ArtifactSchema.parse(rawArtifact);

describe("redactedFieldsFromArtifact", () => {
  it("collects declared-redact input and output field names with their types", () => {
    const fields = redactedFieldsFromArtifact(artifact);
    expect(fields.get("member_id")).toBe("string");
    expect(fields.get("savings_balance")).toBe("money");
  });
});

describe("EvidenceLogger (single sink, invariant #3)", () => {
  it("EDGE-20: replaces a declared redacted field by name, wholesale, regardless of its value", () => {
    const logger = new EvidenceLogger(policy, redactedFieldsFromArtifact(artifact));
    logger.info("output_captured", "run_1", { savings_balance: "$4,231.10", step_id: "read_balance" });
    const [event] = logger.getEvents();
    expect(event?.data["savings_balance"]).toBe("[REDACTED:money]");
    expect(event?.data["step_id"]).toBe("read_balance"); // untouched: not a declared field, no pattern match
  });

  it("scans non-declared string fields for the policy's incidental redaction patterns", () => {
    const logger = new EvidenceLogger(policy, new Map());
    logger.info("observation_text", "run_1", { page_text: "Member 10002 found." });
    const [event] = logger.getEvents();
    expect(event?.data["page_text"]).toBe("Member [REDACTED:member_id] found.");
  });

  it("leaves non-string, non-declared values untouched", () => {
    const logger = new EvidenceLogger(policy, new Map());
    logger.info("step_timing", "run_1", { duration_ms: 412, ok: true });
    const [event] = logger.getEvents();
    expect(event?.data).toEqual({ duration_ms: 412, ok: true });
  });

  it("writes valid newline-delimited JSON, one event per line", () => {
    const logger = new EvidenceLogger(policy, new Map());
    logger.info("a", "run_1");
    logger.warn("b", "run_1");
    const path = join(mkdtempSync(join(tmpdir(), "evidence-logger-test-")), "log.jsonl");
    logger.writeToFile(path);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("a");
    expect(JSON.parse(lines[1]!).level).toBe("warn");
  });
});
