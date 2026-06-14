# Omnipresence — Install Fix & Implementation Hardening

**Date:** 2026-06-14
**Status:** Design — pending review

## Problem

Installing the module fails with:

> The Compendium pack "omnipresence-actors" of the "Actor" type must declare the "system" upon which it depends.

Foundry VTT v13 requires every `Actor`/`Item` compendium pack to declare the game `system` it depends on. The single `omnipresence-actors` pack in `module.json` declares none, so the module will not install.

While fixing this, a full review of the implementation surfaced additional issues — most importantly a permission/architecture flaw (players cannot write to module compendiums) and an ownership-corruption bug on pull. This spec covers the install fix and all hardening fixes together.

## Goals

- Module installs cleanly on Foundry v13.
- Module is a **system-agnostic module** that nonetheless handles **system-specific actors**: a character from a dnd5e world syncs only with other dnd5e worlds, a pf2e character only with pf2e worlds, etc.
- Sync respects Foundry's permission model (only GM-role clients can write compendiums).
- Shared character data is stored as native Foundry compendium Actors (no proprietary/external store).
- Supported systems: **dnd5e, pf2e, daggerheart, draw-steel, shadowdark, CoC7**.

## Non-Goals (YAGNI)

- Live cross-world propagation. Sync remains login-time plus same-world-live (a GM editing/observing in a world). Two worlds open simultaneously do not see each other's changes until a sync trigger fires. Documented as a known limitation.
- Syncing Items, JournalEntries, or other document types.
- Automatic conflict merge (manual choose-a-side dialog is retained).
- Supporting systems beyond the six listed. New systems require a new pack + manifest entry + release.

## Key Constraints Confirmed During Design

- **Actor/Item compendium packs are system-bound.** A pack with `"system": "dnd5e"` is only *loaded* in worlds running dnd5e; in a pf2e world it does not exist. This gates which actors a world can ever see — the same-system restriction is enforced structurally by Foundry, not by our code.
- **Module-level packs are shared across all worlds on the server** (they live in the module folder). This is the mechanism that makes cross-world sync possible. World-level packs are *not* shared, so they cannot be used.
- **Only GM-role users (Gamemaster or Assistant GM) can write to a module compendium.** Regular Player/Trusted-Player accounts cannot, regardless of pack ownership configuration. Foundry sockets are per-world, so a write can only be performed by a GM connected to the same world.
- `relationships.systems` marks a module as compatible with *any* of the listed systems (not "requires all"). Whether Foundry hard-blocks enabling in an unlisted system or only warns is not pinned down in the docs, so code-level graceful disable is retained as defense-in-depth.

## Verified System IDs

| System | `game.system.id` |
|---|---|
| D&D 5e | `dnd5e` |
| Pathfinder 2e | `pf2e` |
| Daggerheart (Foundryborne) | `daggerheart` |
| Draw Steel | `draw-steel` |
| Shadowdark | `shadowdark` |
| Call of Cthulhu 7e | `CoC7` (note capitalization) |

---

## Design

### 1. Per-system compendium packs (`module.json`)

Replace the single `omnipresence-actors` pack with six, each pinned to a system:

```json
"packs": [
  { "name": "omnipresence-dnd5e",       "type": "Actor", "system": "dnd5e",       "path": "packs/omnipresence-dnd5e",       "label": "Omnipresence — D&D 5e" },
  { "name": "omnipresence-pf2e",        "type": "Actor", "system": "pf2e",        "path": "packs/omnipresence-pf2e",        "label": "Omnipresence — Pathfinder 2e" },
  { "name": "omnipresence-daggerheart", "type": "Actor", "system": "daggerheart", "path": "packs/omnipresence-daggerheart", "label": "Omnipresence — Daggerheart" },
  { "name": "omnipresence-draw-steel",  "type": "Actor", "system": "draw-steel",  "path": "packs/omnipresence-draw-steel",  "label": "Omnipresence — Draw Steel" },
  { "name": "omnipresence-shadowdark",  "type": "Actor", "system": "shadowdark",  "path": "packs/omnipresence-shadowdark",  "label": "Omnipresence — Shadowdark" },
  { "name": "omnipresence-CoC7",        "type": "Actor", "system": "CoC7",        "path": "packs/omnipresence-CoC7",        "label": "Omnipresence — Call of Cthulhu 7e" }
]
```

Create the six pack directories, each with a `.gitkeep` (Foundry populates the LevelDB on first write). Remove the old `packs/omnipresence-actors/` directory.

### 2. Mark the module as compatible only with the supported systems

Add a `relationships.systems` block so the module is advertised only for the six supported systems:

```json
"relationships": {
  "systems": [
    { "id": "dnd5e",       "type": "system" },
    { "id": "pf2e",        "type": "system" },
    { "id": "daggerheart", "type": "system" },
    { "id": "draw-steel",  "type": "system" },
    { "id": "shadowdark",  "type": "system" },
    { "id": "CoC7",        "type": "system" }
  ]
}
```

This does **not** force all six systems to be installed; it marks the module as compatible with worlds running any one of them.

### 3. Dynamic pack resolution + graceful disable

Replace the hardcoded `PACK_ID = 'omnipresence.omnipresence-actors'` with resolution by active system:

```js
static get PACK_ID() { return `omnipresence.omnipresence-${game.system.id}`; }
```

If `game.packs.get(PACK_ID)` is `undefined` (active system unsupported, or manifest enforcement is only advisory):
- `onLogin()` no-ops.
- Context-menu enroll/unenroll entries are hidden.
- A single, non-spammy notification informs the user sync is unavailable for this system.

This is belt-and-suspenders behind the manifest restriction in #2.

### 4. Write model — GM performs all writes

Compendium writes happen only on GM-role clients.

- **`updateActor` hook:** the user who made the edit stamps `localModifiedAt` (dirty marker — a user can write their own actor). A GM client performs the debounced compendium push. The hook fires on every connected client in the world, so a GM present in the world sees player edits and pushes them.

  ```js
  Hooks.on('updateActor', (actor, changes, options, userId) => {
    if (options?.omnipresenceInternal) return;
    if (!SyncRegistry.isEnrolled(actor)) return;
    if (userId === game.user.id) SyncEngine.trackLocalModification(actor); // editor marks dirty
    if (game.user.isGM) SyncEngine.debouncedPush(actor);                    // GM persists
  });
  ```

- **`push()`:** if `!game.user.isGM`, return early (the actor is already marked dirty; a GM will persist it). Only GM clients write the pack.

- **Solo player edits with no GM in the world:** remain dirty locally and propagate on the next GM login sweep into that world. This is the accepted trade-off of the GM-writes model.

### 5. Fix the sync-decision logic

The current `onLogin` decides to push via `localSyncTime > compSyncTime`, but local edits never bump `syncedAt` — only `localModifiedAt`. So dirty local edits would never push under the GM-writes model. Redefine the comparison against the dirty marker:

- `localChanged = localModifiedAt > localSyncedAt`
- `compNewer   = compSyncedAt   > localSyncedAt`
- `compNewer && localChanged` → conflict prompt
- `compNewer` only → pull
- `localChanged` only → push (GM only; no-op for players)
- neither → in sync

This aligns with the GM-dashboard's existing `hasConflict = localModifiedAt > syncedAt` indicator.

### 6. Ownership / world-local field handling (corruption bug)

`pull()` currently applies the compendium actor's full `toObject()`, including `ownership` (user IDs from whatever world last pushed) — corrupting who owns the actor in the target world. Fix:

- **On push:** strip `ownership` and `folder` (world-local references) before writing to the compendium. Preserve `flags.omnipresence`.
- **On pull:** strip `ownership` and `folder` from incoming data so the local actor's existing ownership and folder are preserved.
- **Auto-import** retains its existing correct `ownerName` → matched-user ownership remap (it intentionally sets ownership when creating a brand-new actor).

### 7. Smaller fixes

- **`push()` flag guard:** before assigning `syncedAt`, ensure the path exists:
  ```js
  actorData.flags ??= {};
  actorData.flags.omnipresence ??= {};
  ```
- **`ready` hook unlock:** unlock the resolved per-system pack (GM only), not the removed hardcoded id.
- **Context-menu hook compatibility:** make `li` access tolerate both jQuery and native `HTMLElement`, since v13's ApplicationV2 ActorDirectory may pass a native element to `getActorDirectoryEntryContext`. Resolve the document id defensively (e.g. `el.dataset?.documentId ?? $(li).data('documentId')`).

---

## Affected Files

- `module.json` — packs array (#1), relationships.systems (#2).
- `packs/` — create six per-system dirs with `.gitkeep`; remove `omnipresence-actors`.
- `scripts/sync-engine.js` — dynamic PACK_ID (#3), GM-writes guard in `push` (#4), sync-decision logic (#5), field stripping in `push`/`pull` (#6), flag guard (#7).
- `omnipresence.js` — `updateActor` hook rewrite (#4), `ready` unlock target (#7), graceful-disable wiring (#3).
- `scripts/context-menu.js` — jQuery/HTMLElement tolerance + hide when pack absent (#3, #7).
- `scripts/gm-dashboard.js` — `_onForcePull` pack id resolution; honor field-stripping via shared `pull` path.

## Testing Approach

Foundry modules cannot be meaningfully unit-tested without a running instance, so:

1. **Pure-logic extraction + tests where practical.** Extract the sync-decision (#5) and field-stripping (#6) into pure functions that take timestamps / plain objects and return a decision / cleaned object, and cover them with lightweight tests independent of the Foundry runtime.
2. **Manual verification checklist** (in a real Foundry v13 instance):
   - Module installs without the pack-system error.
   - Module is offered/enableable in a world for each of the six systems; verify behavior in an unsupported system (hidden or graceful-disable notice).
   - Enroll an actor (context menu) → appears in the correct per-system compendium.
   - Edit an enrolled actor as GM → change pushes; edit as a player with a GM in-world → change pushes via GM client.
   - Edit as a player with no GM present → stays dirty; pushes on next GM login.
   - Cross-world: GM pulls a newer shared actor into a second world of the same system — ownership and folder are NOT clobbered.
   - Both-sides-changed → conflict dialog; dismissing it makes no change.
   - Confirm a dnd5e world never sees pf2e shared actors and vice versa.

## Known Limitations

- No live cross-world propagation; sync is login-time plus same-world-live.
- Player edits made while no GM is connected to that world wait for the next GM login to propagate.
- Cross-world owner matching is by user *name* (no shared user IDs across worlds); a renamed player breaks auto-import ownership mapping.
