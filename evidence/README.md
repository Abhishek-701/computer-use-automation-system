# evidence

Committed run output (SPEC.md Section 13). Every result here is from a
real run against the live target app and a real browser — none of it is
hand-authored or simulated.

| Directory | Demonstrates |
|---|---|
| `discovery/` | A real LLM-driven discovery run, start to finish, producing a verified artifact. See its own README for the trajectory, the model's reasoning, and the EDGE-26 prompt-injection moment. |
| `replay-success/` | Clean replay: `member_id=10001` in, `savings_balance: "$4,231.10"` out, `status: "success"`. |
| `replay-outcomes/member_not_found/` | `member_id=99999` — `status: "business_outcome"`, `outcome.code: "member_not_found"`, not a crash (invariant #4). |
| `replay-outcomes/boom/` | A seeded HTTP 500 (`?boom=1`) — `status: "failed"`, with `failure.evidence_ref` pointing at a real captured screenshot of the error page. The third bucket of the taxonomy: a hard failure, distinct from both of the above. |
| `escalation/` | A real intervention: raised, handed off, resumed on the same live session, re-anchored, and completed. See its own README for the full cycle and what's mocked. |

The full nine-condition outcome matrix from SPEC.md's Section 10 table
is `[T1]` (SPEC.md Section 15) — this baseline covers one business
outcome and one hard failure, the two buckets `replay-success/` doesn't
already demonstrate.

Every `result.json` here is the literal, unedited output of `src/replay/engine.ts::replay()`
— not reformatted or summarized. `artifacts/member.savings_balance.lookup.json`
(the live capability store) may have moved on since these were captured,
since discovery legitimately re-overwrites it on every run (EDGE-30) —
these are point-in-time proof, not a live mirror.
