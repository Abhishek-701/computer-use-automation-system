/**
 * Seeded-condition flags (SPEC.md Section 10 table). Reachable
 * deterministically by query flag, threaded through the flow as hidden
 * form fields and link query strings so they survive the whole
 * search -> results -> detail -> subaccount -> confirmation path.
 *
 * Design note: `expire` is evaluated declaratively at the step that
 * checks it (the subaccount route), rather than modeled as real cookie
 * expiry over wall-clock time. That keeps the seeded condition
 * deterministic and reproducible on every run, which is the property
 * Section 10 asks for ("reachable deterministically"). A real session
 * timeout is a wall-clock race; this is not meant to demonstrate that,
 * it's meant to demonstrate the escalation path when a session check
 * fails mid-flow.
 */
export interface Flags {
  interstitial: boolean;
  slow: number | null; // ms
  expire: boolean;
  boom: boolean;
  dismissed: boolean;
}

type Source = Record<string, unknown>;

function bool(source: Source, key: string): boolean {
  const v = source[key];
  return v === "1" || v === "true" || v === true;
}

export function parseFlags(...sources: Source[]): Flags {
  const merged: Source = Object.assign({}, ...sources);
  const slowRaw = merged["slow"];
  let slow: number | null = null;
  if (typeof slowRaw === "string" && slowRaw.length > 0) {
    const n = Number(slowRaw);
    if (Number.isFinite(n) && n > 0) slow = Math.min(n, 30_000);
  }
  return {
    interstitial: bool(merged, "interstitial"),
    slow,
    expire: bool(merged, "expire"),
    boom: bool(merged, "boom"),
    dismissed: bool(merged, "dismissed"),
  };
}

/** Serialize active flags as a query string fragment (no leading `?`/`&`). */
export function flagsQuery(flags: Flags, overrides: Partial<Record<string, string>> = {}): string {
  const parts: string[] = [];
  if (flags.interstitial) parts.push("interstitial=1");
  if (flags.slow) parts.push(`slow=${flags.slow}`);
  if (flags.expire) parts.push("expire=1");
  if (flags.boom) parts.push("boom=1");
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return parts.join("&");
}

/** Hidden `<input>` tags carrying active flags forward through a POST. */
export function flagsHiddenInputs(flags: Flags): string {
  const inputs: string[] = [];
  if (flags.interstitial) inputs.push(`<input type="hidden" name="interstitial" value="1">`);
  if (flags.slow) inputs.push(`<input type="hidden" name="slow" value="${flags.slow}">`);
  if (flags.expire) inputs.push(`<input type="hidden" name="expire" value="1">`);
  if (flags.boom) inputs.push(`<input type="hidden" name="boom" value="1">`);
  return inputs.join("\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
