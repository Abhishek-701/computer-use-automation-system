/**
 * The replay result contract (SPEC.md Section 7). Every replay run
 * returns exactly this shape — the three-bucket taxonomy (success /
 * business_outcome / failed, plus failed_dirty and escalated) is the
 * caller-facing surface of SPEC.md invariant #4: a business outcome is
 * a peer of success, not a kind of failure.
 *
 * `outputs` holds real, typed, in-process values — never the redacted
 * string form. Redaction to `"[REDACTED:<type>]"` (EDGE-20) happens at
 * the log sink (src/evidence/logger.ts) when this result is written to
 * a log line, not here: this schema describes what the caller gets back.
 */
import { z } from "zod";

export const ReplayStatus = z.enum(["success", "business_outcome", "failed", "failed_dirty", "escalated"]);
export type ReplayStatusT = z.infer<typeof ReplayStatus>;

export const OutcomeResult = z
  .object({
    code: z.string().min(1),
    message: z.string().optional(),
    detected_at_step: z.string().min(1),
  })
  .strict();

/** Where in a step's execution a hard failure occurred. */
export const FailurePhase = z.enum(["resolve", "act", "expect", "checkpoint"]);

export const FailureResult = z
  .object({
    step_id: z.string().min(1),
    phase: FailurePhase,
    expected: z.string().min(1),
    observed: z.string().min(1),
    /** e.g. "ambiguous_locator", "not_interactable", "frame_vanished" — stable, matchable by tests. */
    error_class: z.string().min(1),
    evidence_ref: z.string().optional(),
  })
  .strict();

export const LocatorDrift = z
  .object({
    step_id: z.string().min(1),
    primary_failed: z.string().min(1),
    resolved_via: z.string().min(1),
  })
  .strict();

export const RecoveredCondition = z
  .object({
    step_id: z.string().min(1),
    condition: z.string().min(1),
    attempts: z.number().int().positive(),
  })
  .strict();

export const Warnings = z
  .object({
    locator_drift: z.array(LocatorDrift).default([]),
    recovered_conditions: z.array(RecoveredCondition).default([]),
  })
  .strict();

export const ControlTransfer = z
  .object({
    at_step: z.string().min(1),
    reason: z.string().min(1),
    handed_off_at: z.string().datetime(),
    resumed_at: z.string().datetime().optional(),
    state_delta_ref: z.string().optional(),
  })
  .strict();

export const EvidenceRefs = z
  .object({
    log: z.string().min(1),
    trace: z.string().optional(),
    screenshots: z.array(z.string()).default([]),
  })
  .strict();

const OutputValue = z.union([z.string(), z.number(), z.boolean()]);

export const ReplayResult = z
  .object({
    status: ReplayStatus,
    capability_id: z.string().min(1),
    capability_version: z.string().min(1),
    tenant: z.string().optional(),
    run_id: z.string().min(1),
    started_at: z.string().datetime(),
    duration_ms: z.number().int().nonnegative(),
    outputs: z.record(z.string(), OutputValue).default({}),
    outcome: OutcomeResult.optional(),
    failure: FailureResult.optional(),
    warnings: Warnings.optional(),
    control_transfers: z.array(ControlTransfer).default([]),
    evidence: EvidenceRefs,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status === "business_outcome" && !result.outcome) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "required when status is business_outcome" });
    }
    if ((result.status === "failed" || result.status === "failed_dirty") && !result.failure) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["failure"], message: `required when status is ${result.status}` });
    }
    if (result.status === "escalated" && result.control_transfers.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["control_transfers"],
        message: "must be non-empty when status is escalated",
      });
    }
  });

export type ReplayResultT = z.infer<typeof ReplayResult>;

export function parseReplayResult(data: unknown):
  | { ok: true; result: ReplayResultT }
  | { ok: false; errors: string[] } {
  const parsed = ReplayResult.safeParse(data);
  if (parsed.success) return { ok: true, result: parsed.data };
  const errors = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return { ok: false, errors };
}
