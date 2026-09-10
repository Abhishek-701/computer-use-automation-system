/**
 * Redaction primitives (SPEC.md Section 8). Redaction happens at the log
 * sink (src/evidence/logger.ts) and the artifact writer
 * (src/schema/artifact.ts::findRedactedLiteralLeaks), never at call
 * sites — this file exists so both of those have one shared
 * implementation to call, instead of each reinventing the substitution.
 *
 * Two distinct mechanisms, both declared in policy.default.json:
 *   - `redactValue`: an artifact's own declared input/output, known by
 *     name and type (e.g. `savings_balance` is `money`, EDGE-20).
 *   - `redactText`: incidental sensitive-shaped text appearing in raw
 *     observed page content or free-form log messages that isn't a
 *     formally declared field — e.g. a member id mentioned in a
 *     results-table row, or an account number in a confirmation
 *     screen. `redaction_patterns` in the policy file are this
 *     defense-in-depth net, independent of what any single artifact
 *     declares.
 */
import type { PolicyT } from "./gate.js";

/** The canonical redacted-value marker, e.g. "[REDACTED:money]". */
export function redactValue(type: string): string {
  return `[REDACTED:${type}]`;
}

/**
 * Replace every occurrence of every configured pattern in free text, in
 * one combined pass. Deliberately NOT one `.replace()` call per
 * pattern applied sequentially: doing that lets an earlier pattern
 * consume characters a later, more specific pattern needed intact —
 * e.g. a bare 5-digit `member_id` pattern would eat the "10002" inside
 * "SA-10002-4821" before an `account_number` pattern ever got to match
 * the whole thing. A single alternation scans left-to-right for match
 * *positions* once, so a pattern that cannot start a match at a given
 * position (like `member_id` at the "S" of "SA-...") naturally yields
 * to one that can, regardless of declaration order.
 */
export function redactText(text: string, patterns: PolicyT["redaction_patterns"]): string {
  if (patterns.length === 0) return text;
  const combined = new RegExp(patterns.map((p, i) => `(?<p${i}>${p.pattern})`).join("|"), "g");
  return text.replace(combined, (...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    for (let i = 0; i < patterns.length; i++) {
      if (groups[`p${i}`] !== undefined) return redactValue(patterns[i]!.name);
    }
    return args[0] as string;
  });
}
