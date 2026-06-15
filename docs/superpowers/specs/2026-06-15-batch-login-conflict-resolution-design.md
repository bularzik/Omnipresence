# Batch login conflict resolution — design

**Date:** 2026-06-15
**Status:** Approved, ready for implementation plan

## Problem

At login, `SyncEngine.onLogin()` walks each owned enrolled actor and, for every
actor in a `conflict` state, `await`s a blocking `ConflictResolver.resolve()`
modal. A player (or GM) with N conflicting characters therefore faces N
sequential modal dialogs, resolving one character at a time.

The module already has a consolidated multi-actor UI — the
`OmnipresenceDashboard` (`scripts/gm-dashboard.js` + `templates/settings-panel.hbs`),
a single table listing every enrolled actor with conflict badges and per-row
actions. The goal is to **reuse that dashboard** to resolve all conflicts at
once instead of prompting per character.

## Goal

At login, auto-sync clean actors silently as today; if any actors are in
conflict, open the existing dashboard filtered to **only the conflicting rows**,
where the user resolves them in one place. The full dashboard remains reachable
from settings, unchanged in that entry path.

## Architecture & data flow

Replace the per-actor conflict prompt in `onLogin()` with a collect-then-surface
flow:

1. Loop owned enrolled actors as today. For `push` / `pull` / `none`, act
   immediately — clean actors still auto-sync silently with no dialog.
2. For `conflict`, **do not prompt**. Collect the actor id into a `conflicts`
   array.
3. After the loop, if `conflicts.length > 0`, open `OmnipresenceDashboard` in a
   new **conflicts-only mode**, passing the conflicting actor ids.

`ConflictResolver` (`scripts/conflict-resolver.js`) is used only by this loop and
becomes dead code; it is removed. GM and player login behavior unify: both get
the consolidated table instead of sequential modals.

## Dashboard changes (`gm-dashboard.js` + `settings-panel.hbs`)

### Conflicts-only mode

The dashboard accepts an optional set of actor ids through its options
(e.g. `new OmnipresenceDashboard({ conflictActorIds })`). When present:

- `_prepareContext` filters `visibleActors` to just those ids and sets a
  `conflictsOnly` flag.
- The window title reflects the mode (e.g. "Resolve sync conflicts").

Opened normally from settings → no filter, full table exactly as today.

### Player row actions

Player rows currently expose only the *remove* (unlink) button. Give player rows
the same **force-push** (↑, "Keep mine") and **force-pull** (↓, "Use shared")
actions the GM rows already have. The existing `_onForcePush` / `_onForcePull`
handlers already permit non-GM *owners* (`if (!game.user.isGM && !actor.isOwner) return;`),
so this is purely a template change — no new permission logic. The player table
thus becomes structurally identical to the GM table; the GM additionally sees
other users' actors and the "Force Sync All" footer button.

### Auto-close

After a resolve action re-renders the dashboard, if `conflictsOnly` is set and no
conflicting rows remain, the window closes itself.

## Enriched conflict rows & accurate badge

To inform the keep-mine / use-shared choice (replacing the old modal's
side-by-side timestamp comparison), `_prepareContext`:

1. Loads the pack once and maps compendium actors by omnipresence id.
2. For each actor computes the action via
   `decideSyncAction({ localSyncedAt, compSyncedAt, localModifiedAt })` and sets
   `hasConflict = action === 'conflict'`.

This replaces the current local-only heuristic (`localModifiedAt > syncedAt`),
making the conflict badge **authoritative** everywhere — both the conflicts-only
login view and the full settings dashboard.

Conflict rows render two timestamps:

- **"Your last edit"** — `localModifiedAt`
- **"Shared updated"** — compendium actor's `syncedAt`

so the user can see which side is newer before choosing.

If the pack load fails, fall back to the existing local-only heuristic so the
dashboard still renders.

## Error handling & edge cases

- **Dismiss without resolving:** closing the dashboard leaves actors dirty; the
  next login re-surfaces them. No data loss (same semantics as dismissing the old
  modal).
- **Partial resolution:** resolving one row re-renders; remaining conflicts stay.
  When the last clears in conflicts-only mode, the window auto-closes.
- **Pack missing / load failure:** the login path already guards a missing pack;
  the dashboard falls back to the local-only heuristic.
- **Concurrent GM edits during the dialog:** force-pull re-reads the pack on
  demand (unchanged), so it uses current shared data.

## Testing

- **Unit (pure, existing Node harness):** `decideSyncAction` is already covered.
  Add a pure helper + test only if any new filter/derivation logic is non-trivial.
- **Manual in Foundry (v13):**
  - Player with 2–3 conflicting characters → a single dashboard opens showing
    only those rows, each with both timestamps. "Keep mine" pushes; "Use shared"
    pulls; the window auto-closes when the last conflict resolves.
  - Clean actors sync silently with no dialog.
  - GM login path behaves identically.
  - Full dashboard opened from settings is unchanged aside from the now-accurate
    badge and player row actions.

## Out of scope

- Changing the sync decision logic in `decideSyncAction`.
- The auto-import branch of `onLogin()` (GM-only) is untouched.
- "Force Sync All" / GM-only footer behavior is unchanged.
