# evidence/tenant-reuse

Live demonstration of the stretch goal "Canonicalization / cross-tenant reuse":
one artifact, discovered once against one app, replayed successfully against
a second, differently-configured instance of the same vendor product — via a
sparse per-tenant overlay, not a re-recording. REPORT.md §4 had named this
the cheapest-to-close gap in the original pass; this closes it.

## The setup

`target-app` now takes a deployment-level `--member-id-label` flag (default
`"Member ID"`) — a stand-in for "the same vendor binary, installed and
branded differently per bank," which is realistically a per-install config
difference, not a per-request one (so it's a server-boot flag, not a seeded
query flag like `?slow=`/`?boom=` elsewhere in this app).

Two live instances, same code, different config:

```
npm run target-app             # :3000, "Member ID"     (the base install)
npm run target-app:tenant-b    # :3001, "Member Number"  (tenant B's install)
```

`artifacts/member.savings_balance.lookup.json` — the same artifact from the
real discovery run in `evidence/discovery/` — carries one new field, added
after the fact with no re-discovery:

```json
"overlays": {
  "tenant_b": {
    "steps": {
      "type_1": { "target": { ... "name": "Member Number" ... } },
      "type_5": { "target": { ... "name": "Member Number" ... } }
    }
  }
}
```

## What's here

- `base/` — the unmodified artifact replayed against the base install
  (`:3000`, no `--tenant` flag). `status: "success"`.
- `tenant_b/` — the *same* artifact, `--tenant tenant_b --base-url
  http://localhost:3001`. The overlay is merged in, re-validated against the
  schema, and the retargeted steps resolve against tenant B's renamed field.
  `status: "success"`, `tenant: "tenant_b"` on the result and in `log.jsonl`.
- `without_overlay/` — the control: the same artifact against `:3001` but
  *without* `--tenant`. Proves the overlay is load-bearing, not cosmetic —
  `status: "failed"`, `error_class: "target_not_found"`, because "Member ID"
  genuinely doesn't exist on that page anymore.

Two step overrides, not the "three-line" overlay from the original design
sketch — this artifact is the genuine 6-step discovery trajectory (with its
real retry-after-reset quirk), not the clean hand-written fixture, so the
"Member ID" field is targeted twice. Still sparse: two fields patched, the
other four steps, all four outcome detectors, and the success checkpoint
carry over untouched.

## What this doesn't prove

Only the search field varies between the two installs here — same routes,
same iframe nesting, same business logic. A real second tenant would also
plausibly differ in class/id hashing (already randomized per-request in
this app, so already exercised) and possibly a different failure-page
wording (would need its own outcome-detector override, same mechanism,
not demonstrated here since it's a repeat of the pattern already proven).
