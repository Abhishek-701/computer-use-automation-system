/**
 * The single log sink (SPEC.md invariant #3: "There is exactly one log
 * sink, and redaction happens there"). No other file in this project
 * should format a log line — everything routes through EvidenceLogger.log()
 * so redaction can never be forgotten at a call site.
 *
 * Two redaction mechanisms, matching src/policy/redact.ts's two:
 *   - A logged field whose NAME matches a declared redacted input/output
 *     is replaced wholesale with "[REDACTED:<type>]" (EDGE-20) — the
 *     real value was already returned to the caller in-process
 *     (result.ts's `outputs`); only the log line redacts it.
 *   - Any OTHER string field is scanned for the policy's incidental
 *     redaction_patterns (e.g. a member id mentioned in free-form
 *     observation text) — defense in depth for data that isn't a
 *     formally declared field but still looks sensitive.
 */
import { writeFileSync } from "node:fs";
import { redactText, redactValue } from "../policy/redact.js";
import type { PolicyT } from "../policy/gate.js";
import type { Artifact } from "../schema/artifact.js";
import { ensureDir } from "./capture.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  event: string;
  run_id: string;
  data: Record<string, unknown>;
}

/** Field name -> declared type, for every input/output an artifact marks `redact: true`. */
export function redactedFieldsFromArtifact(artifact: Artifact): Map<string, string> {
  const map = new Map<string, string>();
  for (const input of artifact.inputs) if (input.redact) map.set(input.name, input.type);
  for (const output of artifact.outputs) if (output.redact) map.set(output.name, output.type);
  return map;
}

export class EvidenceLogger {
  private readonly events: LogEvent[] = [];

  constructor(
    private readonly policy: PolicyT,
    private readonly redactedFields: ReadonlyMap<string, string> = new Map(),
  ) {}

  log(level: LogLevel, event: string, runId: string, data: Record<string, unknown> = {}): void {
    this.events.push({ timestamp: new Date().toISOString(), level, event, run_id: runId, data: this.redact(data) });
  }

  info(event: string, runId: string, data?: Record<string, unknown>): void {
    this.log("info", event, runId, data);
  }
  warn(event: string, runId: string, data?: Record<string, unknown>): void {
    this.log("warn", event, runId, data);
  }
  error(event: string, runId: string, data?: Record<string, unknown>): void {
    this.log("error", event, runId, data);
  }

  private redact(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const declaredType = this.redactedFields.get(key);
      if (declaredType) {
        out[key] = redactValue(declaredType);
        continue;
      }
      out[key] = typeof value === "string" ? redactText(value, this.policy.redaction_patterns) : value;
    }
    return out;
  }

  getEvents(): readonly LogEvent[] {
    return this.events;
  }

  /** Writes newline-delimited JSON (one event per line) to `path`. */
  writeToFile(path: string): void {
    ensureDir(path);
    const content = this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length > 0 ? "\n" : "");
    writeFileSync(path, content, "utf-8");
  }
}
