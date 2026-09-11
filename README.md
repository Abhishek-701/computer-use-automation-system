# Computer-Use Automation System

Discover-once, replay-many automation for legacy back-office UIs that have no API. An LLM
learns a task once by driving a real browser; that run becomes a typed, versioned, reviewable
capability artifact; the artifact is thereafter replayed deterministically with no model in the
decision loop.

Built for the interface.ai take-home assignment ("Assignment A — Computer-Use Automation
System"). Full design rationale is in [`REPORT.md`](./REPORT.md) once written.

> **Status: work in progress.** This README will be filled in as each build checkpoint lands.
> See the checkpoint log below for what exists right now.

## Setup

```
npm install            # also installs the Chromium binary Playwright needs (postinstall)
npm run target-app     # boots the hostile local app on :3000
```

Entry point: `http://localhost:3000/members/search`. See
[`target-app/README.md`](./target-app/README.md) for the full flow, seeded conditions, and
hostile-markup design.

## Config

_To be filled in during CP1._ In short: copy `.env.example` to `.env`. Only `discover` needs
`ANTHROPIC_API_KEY` — replay, show, catalog, stability, and `npm test` run with no key and no
network access.

## Demo path

_To be filled in once discovery and replay exist (CP5–CP6)._ Will be the exact commands from
`SPEC.md` §17, e.g.:

```
npm run target-app
npm run discover -- --goal "..." --target http://localhost:3000/members/search --input member_id=10001
npm run replay   -- --capability member.savings_balance.lookup --input member_id=10001
npm test
```

## Repo layout

See directory-level `README.md` files under `src/`, `target-app/`, `tests/`, `artifacts/`, and
`evidence/` for what belongs where and which checkpoint builds it.

## Checkpoint log

| Checkpoint | Scope | Status |
|---|---|---|
| CP0 | repo, tooling, scaffold | done |
| CP1 | target app (hostile local app) | done |
| CP2 | schemas (artifact, action, result) | done |
| CP3 | surface adapter (Playwright + desktop stub) | done |
| CP4 | policy gate | done |
| CP5 | replay engine | done |
| CP6 | discovery loop | pending |
| CP7 | evidence + escalation | pending |
| CP8 | deliverables (README, REPORT, evidence bundle, golden tests) | pending |
