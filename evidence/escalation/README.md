# evidence/escalation

A real intervention, raised, resumed, and re-anchored, against the live
target app and a real browser (SPEC.md Section 9 P6 acceptance).

## What's here

- `intervention-request.json` — the payload raised when the run got
  stuck: capability id, current step id, reason code, human-readable
  reason, a pruned observation, and a screenshot path.
- `resume-log.txt` — a timestamped log of the whole cycle: intervention
  raised, control handed to the human, the human driving the live
  session, resume signalled, re-anchored and completed.
- `final-result.json` — the replay result contract, with
  `control_transfers` recording `at_step`, `reason`, `handed_off_at`,
  `resumed_at`, and `state_delta_ref`.
- `handoff/before.png` / `handoff/before.json` — screenshot and pruned
  observation at the moment of handoff.
- `handoff/after.png` / `handoff/after.json` — the same, once
  re-anchored, after the human's contribution.

## What it demonstrates

**The trigger.** A step whose target (`role: heading`, no name filter)
resolves to two elements on the account summary page — a deliberately
contrived `ambiguous_locator` failure, chosen because it reproduces
reliably for evidence capture. `src/escalation/session.ts::isStuckCondition`
also recognises `requires_approval`, `not_interactable_*`, an
`on_condition` configured to escalate (e.g. a session-expiry detector),
an exhausted `dismiss_and_retry`, and `checkpoint_not_satisfied` —
covered by `tests/escalation.test.ts` and `tests/replay-engine.test.ts`,
not re-demonstrated here to avoid a redundant capture.

**The handoff is on the same live session, not a fresh one.** The
`adapter` that hit the ambiguous target is the exact same one the
"human" step (a scripted stand-in for a person physically driving the
headed browser window) navigates next, and that `resume()` hands back to
replay for re-anchoring.

**Re-anchoring (EDGE-24), not trust.** The resumed run does not
re-navigate to the entry point or assume it's still on the step it left
off at. It re-observes from scratch; here, the human navigated straight
to a page that already satisfies the success checkpoint, so re-anchoring
takes the "skip ahead" branch (`src/replay/engine.ts`'s `resumeFromStepId`
path) and completes without retrying the ambiguous step at all — a
human finishing the task by hand is itself a legitimate outcome.
`tests/escalation.test.ts` separately covers the other branch: the human
clears the *specific* blocking condition without finishing the task, and
the exact same step is retried and succeeds.

**The human's actions are not recorded into the artifact.** Only the
resulting state (the `after` observation) is captured — see
`src/escalation/session.ts`'s doc comment and REPORT.md Section 5 for why.

## What's mocked, stated plainly

The "human" here is a script driving the same `SurfaceAdapter` the
automation was using — a stand-in for a person looking at the headed
browser window and clicking around themselves. The HTTP layer
(`src/escalation/server.ts`: `GET /intervention`, `GET /operator`,
`POST /resume`) is real and separately tested end-to-end in
`tests/escalation-server.test.ts`; this capture calls `session.resume()`
directly to keep the evidence focused on the state machine and
re-anchoring, not on an HTTP round trip that adds nothing new to verify.
The real product answer, per SPEC.md Section 9, is a co-browsing console
over CDP screencast or VNC — deliberately out of scope here.
