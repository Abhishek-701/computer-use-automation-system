# evidence/discovery-subaccount

A second genuine, live LLM-driven discovery run — for `member.subaccount.open`,
a **mutating, irreversible** capability, unlike `member.savings_balance.lookup`
(read-only). Real model, real target app, real browser, same as
`evidence/discovery/`. Why a second capability at all: the original pass had
exactly one, entirely read-only — nothing in the evidence exercised the
`require_approval` gate for real, on either the discovery or replay side.

## What's here

- `discovery-result.json` — the full 7-step trajectory: search, open
  sub-account, select account type, enter deposit, click Confirm (irreversible,
  approval-gated), read the generated account number.
- `artifact.json` — the persisted capability, identical to
  `artifacts/member.subaccount.open.json`. `click_6` carries
  `mutating: true, risk: "irreversible"` — classified from the same policy
  rule (`^Confirm$`) that gates it at replay time, not asserted by the model.
- `interventions.json` — both `InterventionRequest`s raised during this run,
  full observation + screenshot reference each.
- `approval-1/` — screenshot + pruned observation at the moment discovery's
  own live run asked for approval to click Confirm.
- `handoff/{before,after}.{png,json}` — the same, for the second approval
  raised during EDGE-27's mandatory verification replay (a separate
  execution, from a separate browser — every execution of an irreversible
  action needs its own authorization, not just the first).
- `failure.png` — the verification replay's own failure-screenshot capture,
  taken automatically the instant `require_approval` first fired, before
  the intervention resolved it.

## The two approval contracts, and why they differ

**During discovery** (`discovery_step_6`): the model proposes the click as a
typed tool call; approving lets `discover()`'s own loop execute *that
proposal* via the normal resolve-and-act path
(`src/discovery/loop.ts::handleApprovalEscalation`). The resulting trajectory
step stays attributed to the model, not an unattributed human action — the
artifact stays fully replayable.

**During verification** (`click_6`): this is a fresh `replay()` of the
already-built artifact, using `runReplayWithEscalation` — the exact same
mechanism proven for replay in `evidence/escalation/`. Its re-anchor logic
only ever *skips ahead* if the checkpoint already holds; nothing re-clicks
Confirm on the human's behalf. So the "human" here (a script, same scope
note as `evidence/escalation/README.md` and `evidence/discovery-escalation/README.md`)
clicks Confirm directly on the live session before resuming — matching
`tests/escalation.test.ts`'s already-tested "skip ahead" branch exactly.

**The completed safety story**: `npm run replay -- --capability
member.subaccount.open ...` with no escalation wired (the plain, unattended
path) refuses outright:

```json
{ "status": "failed", "failure": { "step_id": "click_6", "error_class": "requires_approval" } }
```

An irreversible action in this system can never execute without a live
human-in-the-loop decision — proven here for real on both the discovery and
replay side, not just asserted.

## Two real bugs this run caught, fixed before this capture

1. **`SurfaceAdapter.act()`'s click has no built-in wait for a navigation it
   triggers.** Replay tolerates this because every step polls a declared
   `expect`/checkpoint (`waitForCondition`); discovery took exactly one
   immediate `observe()` per turn with no polling at all. A form-submit
   click reloading the nested content iframe reliably raced ahead of that
   single observation — the model, seeing what looked like the unchanged
   form, sometimes derailed into repeating the whole flow from scratch
   (visible in two earlier, uncommitted attempts at this same run: 17 and
   21-step trajectories, both containing a full duplicate sub-account
   creation, both failing verification). Fixed with `settledObserve()`
   (`src/discovery/loop.ts`): poll until two consecutive observations agree
   or a bound elapses — the same "wait for stability, not the first
   transient match" rule REPORT.md §3 already states for replay's
   checkpoints, now applied to discovery's own action loop too. Regression
   test: `tests/discovery-escalation.test.ts`, reproducing this exact
   click-then-race scenario against the real target app.
2. **`onIntervention` had no way to let an automated "human" act on the live
   session before resuming.** Needed for the verification-side approval
   above — without it, resuming without first clicking Confirm just retries
   the same now-blocked step and fails again. Fixed by passing the live
   `adapter` through to `onIntervention` in both
   `escalation/session.ts::EscalationParams` and
   `discovery/loop.ts::DiscoveryEscalationParams` — additive, so every
   existing single-argument callback (including `tests/escalation.test.ts`'s)
   stays valid unchanged.
