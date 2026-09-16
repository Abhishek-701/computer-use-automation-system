# evidence/stability

Live demonstration of the "confidence & approval" + "multi-run stability"
stretch goals, run in this order against the real discovered artifact
(`artifacts/member.savings_balance.lookup.json`).

## The design

`npm run stability` replays an artifact N times, tallies the batch, and
writes `provenance.stability` to the artifact file. It never itself
changes `capability.status` — a score is evidence for a human decision,
not the decision (REPORT.md §2's whole reason the draft gate exists in
the first place). Promotion is a separate, explicit action:
`npm run show -- --capability <id> --promote` (draft → verified, refuses
without a clean report on file) and `--approve` (verified → approved,
refuses unless already verified).

"Clean" requires **at least one real `success`**, zero failures, zero
locator drift — not merely zero failures. A batch run entirely against a
not-found input is *repeatable*, not *working*, and must not read as
reliable.

## What's here

- `not_eligible/` — 3 runs against `member_id=99999`. All 3 return
  `business_outcome` (not a crash — invariant #4). `report.json`:
  `successes: 0`. `console.txt` shows `--promote` correctly refusing:
  *"cannot promote: no clean provenance.stability report on file."*
  This is the exact trap a naive "zero failures = reliable" score would
  miss — proving it's actually being checked, not just documented.
- `clean/` — 5 runs against `member_id=10001`. All 5 succeed, zero
  drift. `--promote` succeeds (draft → verified), `--approve` succeeds
  (verified → approved), and a final `replay` **without** `--allow-draft`
  succeeds — the actual functional payoff: the capability that couldn't
  run unattended at the top of this file now can, on the strength of
  real replay evidence plus an explicit human sign-off, not either alone.

## What this doesn't do

`verified_replays`/`last_verified_at` are bumped by a stability batch's
successes, deliberately kept as one counter rather than living beside a
disagreeing one — see the schema doc-comment on `Provenance.verified_replays`.
No confidence *score* beyond the binary eligibility check is computed
(no weighted average, no time-decay) — the brief asks for "a
stability/flakiness signal," and a plain tally already gives a reviewer
everything they need to make that call themselves.
