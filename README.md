# Computer-Use Automation System

Discover-once, replay-many automation for legacy back-office UIs that have no API. An LLM
learns a task once by driving a real browser; that run becomes a typed, versioned, reviewable
capability artifact; the artifact is thereafter replayed deterministically with no model in the
decision loop. A policy gate sits between every proposed action and the surface, and a human can
take over the live session when the system gets stuck.

Built for the interface.ai take-home assignment ("Assignment A — Computer-Use Automation
System"). Full design rationale — the four architectural invariants, the artifact schema, the
error taxonomy, escalation, safety, and what was cut — is in [`REPORT.md`](./REPORT.md).

## Setup

Requires Node 20+.

```
npm install            # also installs the Chromium binary Playwright needs (postinstall)
cp .env.example .env   # fill in ANTHROPIC_API_KEY — only `discover` needs it
```

## Running without live services

`replay` and `show` run with **no API key and no network access** — they only need the local
target app running. `npm test` needs neither either: its browser-integration suites boot their
own ephemeral copy of the target app in-process (`createTargetApp().listen(0)`) and tear it down
after, so it doesn't need `npm run target-app` started first. Only `discover` calls the Anthropic
API and needs `ANTHROPIC_API_KEY` set.

## Demo path

Terminal 1 — boot the hostile target app:

```
npm run target-app                                  # :3000, entry point /members/search
```

Terminal 2 — run the agent on a goal, then replay the resulting artifact:

```
npm run discover -- --goal-spec goal-specs/member.savings_balance.lookup.json --input member_id=10001

npm run replay   -- --capability member.savings_balance.lookup --input member_id=10001 --allow-draft
npm run replay   -- --capability member.savings_balance.lookup --input member_id=99999 --allow-draft

npm run show     -- --capability member.savings_balance.lookup

npm test
```

`--allow-draft` is required because a freshly-discovered artifact's `capability.status` is
`"draft"` — a draft refuses unattended replay without the flag, intentional gating so an
unreviewed capability can't run in production by accident, not a workaround. `discover` needs a
`--goal-spec` file (see
[`goal-specs/member.savings_balance.lookup.json`](./goal-specs/member.savings_balance.lookup.json))
declaring the capability's inputs, outputs, success checkpoint, and known business outcomes up
front — the same parameterisation philosophy REPORT.md §2 argues for; `--goal` and `--target`
optionally override the file's own goal text / entry point.

Expected results:
- `member_id=10001` → `status: "success"`, `outputs.savings_balance: "$4,231.10"`
- `member_id=99999` → `status: "business_outcome"`, `outcome.code: "member_not_found"`

A real run of both is committed at [`evidence/`](./evidence/) — see its README for the full
index, including a genuine LLM-driven discovery run with the model's own reasoning at each step,
a live escalation/resume cycle for both replay and discovery, a live cross-tenant reuse demo (the
same discovered artifact, unmodified, replayed against a second app instance via a two-line
`overlays` patch), and a live confidence/approval cycle (below) that took that same artifact from
`draft` to `approved` on real replay evidence.

## CLI reference

| Command | Purpose |
|---|---|
| `npm run target-app` | Boot the hostile target app on `:3000` |
| `npm run target-app:tenant-b` | Boot a second, differently-labeled instance on `:3001` — stand-in for another bank's install of the same vendor product; see [`evidence/tenant-reuse/`](./evidence/tenant-reuse/) |
| `npm run discover -- --goal-spec <path> --input k=v [--goal "..."] [--target <url>] [--headed]` | Run a live LLM discovery session; verifies and persists to `artifacts/<capability_id>.json`. `--headed` is required for a human to actually be able to intervene if the model reports being stuck — see [`evidence/discovery-escalation/`](./evidence/discovery-escalation/) |
| `npm run replay -- --capability <id> --input k=v [--tenant <id>] [--allow-draft] [--base-url <url>]` | Deterministic replay, no model in the loop |
| `npm run stability -- --capability <id> --input k=v [--runs N]` | Replay N times (sequential), tally the batch, write `provenance.stability` — never changes `capability.status` itself; see [`evidence/stability/`](./evidence/stability/) |
| `npm run show -- --capability <id> [--promote] [--approve]` | Validate and pretty-print a saved artifact; `--promote` (draft→verified) requires a clean `provenance.stability` report on file, `--approve` (verified→approved) requires already-verified — both explicit, human-invoked, never automatic |
| `npm test` | Full test suite (unit + live-browser integration, no API key needed) |

`catalog` is the one optional-tier command deliberately not implemented in this pass — it prints
a clear message rather than failing silently or doing nothing.

## Repo layout

```
/src/surface      SurfaceAdapter — the only code that knows about Playwright
/src/schema       zod schemas: artifact, action, replay result
/src/policy       enforce() — the single gate to the adapter
/src/replay       deterministic executor, locator resolution, condition matcher
/src/discovery    LLM tool-calling loop, trajectory recorder
/src/escalation   control_owner state machine, intervention HTTP server
/src/evidence     single log sink (redaction happens here), screenshot capture
/src/cli          discover | replay | show | catalog | stability
/target-app       the deliberately hostile local app used for discovery/replay demos
/goal-specs       operator-declared goal specs for discovery
/artifacts        saved capability artifacts
/evidence         committed run output — see evidence/README.md
/tests            golden invariant tests + full suite
```

See directory-level `README.md` files under `src/`, `target-app/`, and `evidence/` for more.

## Design write-up

[`REPORT.md`](./REPORT.md) — Architecture, Artifact schema, Determinism & error handling,
Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts.
