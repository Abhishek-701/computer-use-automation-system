# evidence/discovery-escalation

Live demonstration of the brief's §3.6 first escalation trigger — *"the
agent is stuck **during discovery**"* — against the real live target
app and a real Playwright adapter. Previously only replay's stuck
detection was wired to `EscalationSession`; discovery's own
`report_stuck` tool just ended the run with no human ever able to touch
the live session. This closes that gap.

## What's here

- `handoff-1/before.{png,json}` — screenshot + pruned observation at the
  moment of the intervention: the target app's seeded interstitial
  (`?interstitial=1`, an `alertdialog` named "System Announcement") is
  blocking the page, and discovery's closed action vocabulary has no
  tool that can dismiss an `alertdialog` directly.
- `handoff-1/after.{png,json}` — the same, after the human's
  intervention: the dialog is gone, the search form is usable.
- `summary.json` — the full cycle: the `InterventionRequest` raised,
  the resume result, and the post-handoff observation.

## What this demonstrates

**The design decision, not just the trigger.** On resume, control goes
straight back to the *model*, not to "finish the task by hand" — this
is deliberately the same "continue" branch `tests/escalation.test.ts`
proves for replay, not replay's "skip ahead" branch. A human clearing a
specific blocker (here: dismissing a dialog outside the model's
vocabulary) keeps every recorded trajectory step attributable to a
typed, model-driven action. If a human instead finished the whole task
by hand, the resulting artifact would have a gap no replay could ever
reproduce (no model in that loop) — so unlike replay's escalation,
discovery's only sensible re-anchor is "unblock and hand back," not
"skip ahead."

**Origin/route re-checked on the handoff observation too** (EDGE-08's
rule, extended here): a human driving the live session could navigate
anywhere; the resumed observation's URL is checked against the policy
allowlist exactly like every other observation in this system, not
trusted just because a person produced it.

## What's mocked, stated plainly

Same scope note as `evidence/escalation/README.md`: the "human" here is
a script driving the same `SurfaceAdapter` the automation was using —
a stand-in for a person looking at a **headed** browser window
(`discover --headed`) and clicking around themselves. `handleStuckEscalation`
itself is real and unit-tested end-to-end, both branches (resumed,
abandoned), in `tests/discovery-escalation.test.ts`; this capture calls
it directly against a live adapter, the same way `evidence/escalation/`
calls `session.resume()` directly, to keep the evidence focused on the
handoff mechanism rather than a full genuine LLM run that would need to
organically get stuck to exercise it (unreliable to force, and not the
part this evidence needs to prove).
