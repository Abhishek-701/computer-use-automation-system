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

`replay`, `show`, and `npm test` run with **no API key and no network access** — they only need
the local target app running. Only `discover` calls the Anthropic API.

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
`"draft"` (SPEC.md §6: draft artifacts refuse unattended replay without it) — this is intentional
gating, not a workaround. `discover` needs a `--goal-spec` file (see
[`goal-specs/member.savings_balance.lookup.json`](./goal-specs/member.savings_balance.lookup.json))
declaring the capability's inputs, outputs, success checkpoint, and known business outcomes up
front (EDGE-01's parameterisation philosophy applied consistently — see REPORT.md §2); `--goal`
and `--target` optionally override the file's own goal text / entry point.

Expected results:
- `member_id=10001` → `status: "success"`, `outputs.savings_balance: "$4,231.10"`
- `member_id=99999` → `status: "business_outcome"`, `outcome.code: "member_not_found"`

A real run of both is committed at [`evidence/`](./evidence/) — see its README for the full
index, including a genuine LLM-driven discovery run with the model's own reasoning at each step
and a live escalation/resume cycle.

## CLI reference

| Command | Purpose |
|---|---|
| `npm run target-app` | Boot the hostile target app on `:3000` |
| `npm run discover -- --goal-spec <path> --input k=v [--goal "..."] [--target <url>] [--headed]` | Run a live LLM discovery session; verifies and persists to `artifacts/<capability_id>.json` |
| `npm run replay -- --capability <id> --input k=v [--tenant <id>] [--allow-draft] [--base-url <url>]` | Deterministic replay, no model in the loop |
| `npm run show -- --capability <id>` | Validate and pretty-print a saved artifact |
| `npm test` | Full test suite (unit + live-browser integration, no API key needed) |

`catalog` and `stability` are optional-tier commands (SPEC.md §15, T1/T2) — not implemented; they
print a clear message rather than failing silently.

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
/target-app       the deliberately hostile local app (SPEC.md §10)
/goal-specs       operator-declared goal specs for discovery
/artifacts        saved capability artifacts
/evidence         committed run output — see evidence/README.md
/tests            golden invariant tests + full suite
```

See directory-level `README.md` files under `src/`, `target-app/`, and `evidence/` for more.

## Design write-up

[`REPORT.md`](./REPORT.md) — Architecture, Artifact schema, Determinism & error handling,
Heterogeneity & multi-tenant, Escalation & handoff, Safety, Cuts.
