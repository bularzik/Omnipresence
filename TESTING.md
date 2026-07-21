# Testing

Omnipresence has two test suites: a pure-layer unit suite and an end-to-end
Playwright suite that drives a live Foundry server.

## Unit tests

```bash
npm test                              # run all unit tests (Node's built-in runner)
node --test tests/sync-logic.test.js  # run a single test file
```

88 tests. Only the **pure** layer (`scripts/sync-logic.js`) is unit-tested —
everything that touches Foundry globals (`game`, `Hooks`, `ui`, `ApplicationV2`)
is not unit-testable and is covered by the Playwright suite below instead,
plus manual verification for the onboarding dialog, which has no automated
coverage. When changing the dashboard or sync engine, plan on manual
verification — bugs there (e.g. ApplicationV2 wiring) won't surface in
`npm test`.

## End-to-end tests

```bash
npm run test:e2e                                    # full Playwright suite
npx playwright test tests/e2e/allow-list.spec.js    # one spec
```

30 tests across 9 spec files (`allow-list`, `embedded-sync`, `journal-sync`,
`link-rewriting`, `map-pins`, `pack-staleness`, `sync-followups`,
`sync-followups-2`, `user-config`).

The e2e suite drives a **live Foundry server** — there are no fixtures or
mocks. Before every run:

1. Copy the runtime files into the (separate, non-git) Foundry install:
   ```bash
   cp -R scripts omnipresence.js templates styles lang module.json \
     /Users/danbularzik/FoundryVTT/Data/Data/modules/omnipresence/
   ```
   Skipping this is the single most common cause of a spec failing in a way
   that exactly matches the pre-change behavior.
2. Start the server: `/Users/danbularzik/FoundryVTT/start-foundry.command`
   (serves `http://localhost:30000`; `stop-foundry.command` stops it).
3. Make sure **World B** is the active world, with its fixtures present — every
   spec expects it (see the fixture table below).

Specs run with `workers: 1` (see `playwright.config.js`) because they share one
world and mutate it. Each spec's `beforeAll` asserts its fixtures and throws a
message naming exactly what is missing — read that before debugging anything
else.

### World fixtures

The specs assume these documents exist in World B:

| Fixture | Id | Baseline |
|---|---|---|
| Actor "Omnipresence Test Actor" | `xpxoPgW6ThcdsfRW` | 39 items, 0 effects |
| Item on that actor (nested-effect host) | `bQvPrEX9Ey8oVCYw` | 0 effects |
| Journal "Omnipresence Test Journal" | omnipresence id `J18k6yVYeThQSRup` | 2 pages |

`embedded-sync.spec.js` asserts those baselines in `afterAll`, so a run that
corrupts the world fails loudly rather than passing green.

### Run the suite twice

Specs that create their own documents name them `Omni … Probe` and delete
both the world document and its pack copy in a guarded `finally` block — a
spec that leaks state passes alone but fails on a second consecutive run,
which is why it's worth running the suite twice after touching
sync/reconcile logic.

### Troubleshooting: no active world

If every spec times out inside `loginToFoundry` (not a specific assertion
failure), the server most likely has no world launched — check
`http://localhost:30000/api/status` for `"active":true`. Relaunching a world
doesn't need the admin UI; from any page on `http://localhost:30000`, run:

```js
await fetch('/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'launchWorld', world: 'world-b' }) });
```

(Available worlds: `world-a`, `world-b`.) Then poll `/api/status` until it
reports `"active":true`. Note this relaunch call only succeeds when no world
is currently active — Foundry 403s `launchWorld` while a world is already
running, so it's specific to this "no active world" scenario, not a general
world-switch tool.

## Local Foundry install (for manual verification)

The module runs from a *separate, non-git copy* at
`/Users/danbularzik/FoundryVTT/Data/Data/modules/omnipresence`. Copy changed
runtime files there before testing. Start the server with
`/Users/danbularzik/FoundryVTT/start-foundry.command` (it runs
`node main.js --dataPath=…`, serving on `http://localhost:30000`);
`stop-foundry.command` stops it. Worlds `World A`/`World B` (both dnd5e) exist
for exercising cross-world sync; the e2e suite itself targets World B only.
