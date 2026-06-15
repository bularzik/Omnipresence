# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Omnipresence is a Foundry VTT **v13** module that synchronizes player character actors across multiple worlds on the same Foundry server. It is plain ES modules loaded directly by Foundry — there is no build/bundle step.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

No build step — Foundry loads `omnipresence.js` and `scripts/*.js` as ES modules directly.

```bash
npm test                              # run all unit tests (Node's built-in runner)
node --test tests/sync-logic.test.js  # run a single test file
```

Only the **pure** layer (`scripts/sync-logic.js`) is unit-tested. Everything that touches Foundry globals (`game`, `Hooks`, `ui`, `ApplicationV2`) is **not** unit-testable and must be verified by running it in a live Foundry world (drive it with the Playwright MCP, or by hand). When changing the dashboard or sync engine, plan on manual verification — bugs there (e.g. ApplicationV2 wiring) won't surface in `npm test`.

**Local Foundry install** (for manual verification): the module runs from a *separate, non-git copy* at `/Users/danbularzik/FoundryVTT/Data/Data/modules/omnipresence`. Copy changed runtime files there before testing. Start the server with `/Users/danbularzik/FoundryVTT/start-foundry.command` (it runs `node main.js --dataPath=…`, serving on `http://localhost:30000`); `stop-foundry.command` stops it. Worlds `World A`/`World B` (both dnd5e) exist for exercising cross-world sync.

**Releases** are triggered by pushing a `v*` git tag (use the `/publish` skill — it bumps from the latest tag and pushes). `.github/workflows/release.yml` patches `module.json`'s `version`/`manifest`/`download` from the tag and builds the zip. The committed `module.json` `version` intentionally lags — **git tags are the source of truth for the version**, not `module.json`.

## Architecture Overview

System-agnostic cross-world actor sync. The shared source of truth is a **per-game-system compendium pack** (`PACK_ID = omnipresence.omnipresence-${game.system.id}`, declared in `module.json` `packs`). Every world on the server with the module active reads/writes the same pack files on disk; that is how characters cross worlds. Supported systems are enumerated in `module.json` (dnd5e, pf2e, daggerheart, draw-steel, shadowdark, CoC7); an unsupported active system is a no-op with a GM notification.

Key cross-cutting facts:

- **Identity:** each enrolled actor carries a stable UUID `flags.omnipresence.id`, used to match copies across worlds even after rename. Embedded-document `_id`s are preserved (`keepId`) as the match key for inventory/spells/effects reconciliation.
- **Enrollment** is stored in the world setting `omnipresence.syncRegistry` (an `id → true` map), *not* a flag. `SyncRegistry.isEnrolled` checks both the actor's flag id and registry membership.
- **Sync decision is timestamp-based** from three values: local `flags.omnipresence.syncedAt`, local `flags.omnipresence.localModifiedAt`, and the compendium copy's `syncedAt`. `decideSyncAction` (pure) returns `push | pull | conflict | none`.
- **GM-write-only:** only GM-role clients can write to a module compendium, so `SyncEngine.push()` is a no-op for non-GMs. Players resolve conflicts by **pulling only**; "keep mine" is GM-only.

Module layering (respect the boundary — keep logic in the pure layer where possible):

- `scripts/sync-logic.js` — **pure, Foundry-independent** helpers (`decideSyncAction`, `deriveConflictState`, `diffEmbedded`, `resolveOwningActor`, `stripWorldLocalFields`). The only unit-tested file.
- `scripts/sync-engine.js` — orchestration: `push`/`pull`/`onLogin`, debounced GM push, embedded-collection reconcile. Foundry-coupled.
- `scripts/sync-registry.js` — enrollment state and owner-name resolution.
- `scripts/gm-dashboard.js` — `ApplicationV2` settings dashboard; also opens in a **conflicts-only mode** at login (filtered to conflicting actors) instead of one modal per character.
- `scripts/context-menu.js` — Actors Directory enroll/unenroll context menu.
- `omnipresence.js` — entrypoint: registers settings/hooks (`init`, `ready`→`onLogin`, `updateActor`, embedded create/update/delete, `getActorContextOptions`).

Data flow: editing an enrolled actor marks it dirty (`localModifiedAt`) on the editing user's client and schedules a debounced GM push; embedded-doc changes (items/effects) don't fire `updateActor`, so they're routed to the owning actor via `resolveOwningActor`. `onLogin` reconciles each owned enrolled actor and surfaces any conflicts in the conflicts-only dashboard.

## Conventions & Patterns

- **`{ omnipresenceInternal: true }` on every internal write.** All document updates the module makes to sync metadata/data carry this option so the `updateActor`/embedded hooks ignore them. Omitting it causes sync loops. Always set it.
- **`sync-logic.js` must stay Foundry-independent** — no `game`/`Hooks`/`CONST`/`ui`, no `node:` imports — so it runs under both the Node test runner and the browser. New decision logic belongs here (testable), with the Foundry-coupled callers kept thin.
- **World-local fields (`_id`, `ownership`, `folder`) never cross the compendium** — strip them with `stripWorldLocalFields` before writing shared, and re-apply local ownership/folder on pull.
- **ApplicationV2 `actions` must map to handler functions**, not `true`/booleans (a boolean throws `handler?.call is not a function` at click time).
- **TDD for the pure layer; manual Foundry verification for everything else.** This split is deliberate — don't claim UI/engine changes work on the basis of `npm test` alone.
