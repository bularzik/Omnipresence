# Omnipresence — Design Spec
_Date: 2026-06-13_

## Overview

Omnipresence is a Foundry VTT v13+ module that synchronizes player character actors across multiple worlds on the same Foundry server. It enhances the manual compendium workflow by tracking which actors are enrolled in sync and keeping them automatically up to date.

**Scope:** Same-server multi-world sync. Cross-server sync is explicitly out of scope for v1.

---

## Architecture

Five components with clear boundaries:

### SyncEngine
Core push/pull logic. Stateless beyond a debounce timer (2s). Accepts an actor and a compendium pack reference, performs the read or write operation, updates sync metadata flags, and returns the result. Does not decide whether to sync — that is the SyncRegistry's job.

### SyncRegistry
Tracks which actors are enrolled in sync within this world. Stored as a world-level module setting: a map of `{ [omnipresence-uuid]: true }`. All other components consult the registry before acting.

### ConflictResolver
A Foundry `Application` dialog shown on login when both the local actor and its compendium counterpart have been modified since the last sync. Presents both versions with timestamps, lets the user choose one. Shown once per conflicting actor, sequentially.

### GMDashboard
A Foundry `Application` registered via `game.settings.registerMenu()`. Appears as a button in the Omnipresence section of Configure Settings. GMs see all synced actors across all users in this world: name, owner, last synced timestamp, conflict status, and per-actor force push/pull/remove controls plus a "Force Sync All" button. Players see only their own actors with a remove control. The same class renders both views conditionally based on `game.user.isGM`.

### Hooks & Entry Point (`omnipresence.js`)
Registers all Foundry hooks. No logic lives here — just wiring.

---

## Shared Compendium

A module compendium pack (`omnipresence-actors`) bundled with the module, stored at `Data/modules/omnipresence/packs/omnipresence-actors/` (LevelDB format, Foundry v13+). The module unlocks it for writing on `init`. All worlds with the module active share the same physical pack files — this is the single source of truth.

---

## Actor Identity

Each enrolled actor is stamped with two flags:

- `flags.omnipresence.id` — a UUID generated at enrollment time. Stable across renames. Used to match actors across worlds.
- `flags.omnipresence.syncedAt` — ISO timestamp of the last successful sync. Used for conflict detection.

---

## Data Flow

### Enrolling an actor
1. User (or GM) right-clicks actor in Actors Directory → "Add to Omnipresence Sync"
2. Module stamps `flags.omnipresence.id` and `flags.omnipresence.syncedAt` on the actor
3. SyncRegistry records the UUID in world settings
4. SyncEngine immediately pushes the actor to the module compendium

### Unenrolling an actor
1. User (or GM) right-clicks → "Remove from Omnipresence Sync"
2. SyncRegistry removes the UUID from world settings
3. Actor remains in the world and in the compendium — it is simply no longer tracked

### Deleting an enrolled actor from the world
1. `deleteActor` hook fires
2. SyncRegistry removes the UUID from world settings
3. Compendium entry is left intact as the master copy
4. On next login to any world where the owner exists, the auto-import flow will recreate the actor from the compendium

### On actor update
1. `updateActor` hook fires
2. SyncEngine checks SyncRegistry — is this actor enrolled?
3. If yes: debounce 2s, then push to compendium, update `flags.omnipresence.syncedAt`

### On user login (`ready` hook)
For each enrolled actor owned by the logging-in user:
- Compare local `flags.omnipresence.syncedAt` vs compendium `flags.omnipresence.syncedAt`
- **Compendium newer, local unchanged:** pull silently
- **Compendium newer, local also changed:** show ConflictResolver dialog
- **Local newer:** push to compendium (covers cases where module was inactive)

Additionally, scan the compendium for actors with `flags.omnipresence.id` values not present in this world, where the actor's recorded owner name matches a user in this world. For each match: create the actor, assign ownership to the matching user, enroll in sync.

### Conflict resolution
User sees local and shared versions with timestamps and chooses one. The chosen version becomes the new master; `syncedAt` updates; the other version is overwritten.

---

## Context Menu

Hook: `getActorDirectoryEntryContext`

Visibility condition: `game.user.isGM || actor.isOwner`

- When not enrolled: **"Add to Omnipresence Sync"**
- When enrolled: **"Remove from Omnipresence Sync"**

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Compendium write fails (pack unexpectedly locked) | Catch, log, show Foundry UI notification: "Omnipresence: sync failed for [name]" |
| Actor missing from compendium on pull | Treat as fresh enrollment — push local copy as new master |
| User name mismatch on login import | Skip import, log warning — GM resolves via dashboard |
| Pending push interrupted by logout | Flush via `closeWorld` hook before page unloads |

---

## Module File Structure

```
omnipresence/
├── module.json
├── omnipresence.js           # entry point, hook registration
├── scripts/
│   ├── sync-engine.js
│   ├── sync-registry.js
│   ├── conflict-resolver.js
│   ├── gm-dashboard.js
│   └── context-menu.js
├── templates/
│   ├── conflict-dialog.hbs
│   └── settings-panel.hbs
├── packs/
│   └── omnipresence-actors/  # LevelDB compendium pack
├── lang/
│   └── en.json
└── styles/
    └── omnipresence.css
```

---

## Compatibility

- **Minimum:** Foundry VTT v13
- **Verified:** Foundry VTT v13
- **Game systems:** System-agnostic (syncs full actor document without interpreting system data)
- **Cross-server sync:** Not in scope for v1

---

## Testing

Manual testing against a local Foundry v13 instance. Test matrix:

- Enroll actor via context menu (player and GM)
- Unenroll actor via context menu (player and GM)
- Edit enrolled actor → verify compendium updates within ~2s
- Login with enrolled actor → silent pull when compendium is newer
- Login with conflict → ConflictResolver dialog appears, choice is respected
- Login with compendium actor not in world → actor auto-created with correct ownership
- GM dashboard: force push, force pull, remove, Force Sync All
- Player settings panel: shows only own actors, remove works
