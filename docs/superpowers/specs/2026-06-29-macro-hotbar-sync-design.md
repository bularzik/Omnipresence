# Macro Hotbar Sync — Design Spec

**Date:** 2026-06-29
**Status:** Approved

## Overview

Extend Omnipresence to synchronize a player's hotbar macros across worlds, using the same shared-compendium architecture already in place for actor sync. Users opt in or out via a new "Omnipresence" section injected into the standard Foundry User Configuration dialog.

---

## 1. Data Model

### New compendium pack

Add one system-agnostic `Macro` pack to `module.json`:

```json
{
  "name": "omnipresence-macros",
  "type": "Macro",
  "path": "packs/omnipresence-macros",
  "label": "Omnipresence — Macros"
}
```

No `system` restriction. All users across all game systems share one macro pack.

### Flags on compendium macro entries

Each entry in `omnipresence.omnipresence-macros` carries:

| Flag | Type | Purpose |
|---|---|---|
| `flags.omnipresence.id` | string | Stable cross-world identity (16-char randomID). Also stamped on the local macro doc. |
| `flags.omnipresence.ownerName` | string | Foundry username whose hotbar this entry belongs to. |
| `flags.omnipresence.hotbarSlots` | number[] | Slot numbers (1–50, five pages × 10 slots) where this macro lives on that user's bar. |

Two users who share a macro document in the same world each get a separate compendium entry (different `ownerName`). Deduplication is not attempted.

### Sync preferences setting

A single `scope: 'world'` Object setting `omnipresence.syncPrefs` stores per-user preferences:

```js
// shape: { [userId]: { actors: boolean, macros: boolean } }
// default for any userId not in the map: { actors: true, macros: true }
```

Registered alongside the existing `syncRegistry` setting in `SyncRegistry.register()`.

---

## 2. User Configuration UI

### Injection point

A new `renderUserConfig` hook injects an "Omnipresence" `<fieldset>` into the User Configuration dialog (the dialog that opens when a player clicks their avatar). The fieldset contains two checkboxes:

- **Synchronize player characters across worlds** (default: checked)
- **Synchronize hotbar macros across worlds** (default: checked)

Each checkbox saves immediately on `change` to `omnipresence.syncPrefs` for `game.user.id` — no need to intercept form submission.

### Actor sync pause behavior

When "Synchronize player characters" is unchecked:
- The `updateActor` hook checks `syncPrefs[userId].actors` (where `userId` is the user who made the edit, from the hook argument) and bails early if false — no `trackLocalModification` on the editing client, no `debouncedPush` on the GM client
- The "Add to Omnipresence sync" and "Remove from Omnipresence sync" context menu items are hidden (checked via `condition` in `context-menu.js`)
- Enrolled actors **remain enrolled** (flags and registry untouched) — this is a pause, not an unenroll. Re-enabling resumes sync from existing timestamps.
- On login, `SyncEngine.onLogin()` skips actor reconciliation for this user.

---

## 3. Push Data Flow

### Triggers

| Hook | Condition | Action |
|---|---|---|
| `updateMacro` | Macro is on any opted-in user's hotbar | Debounced push for each affected user |
| `updateUser` (with `changes.hotbar`) | User is opted in for macro sync | Debounced push for that user |

`deleteMacro` requires no special handling: Foundry auto-clears the hotbar slot, which fires `updateUser`, which pushes a snapshot with that slot absent and deletes the stale compendium entry naturally.

### Push logic (GM-only)

`MacroSync.pushForUser(user)`:

1. Bail if `!game.user.isGM`.
2. Bail if `!MacroSync.isOptedIn(user)` (checks `syncPrefs[user.id].macros`).
3. Load the macro compendium; get all existing entries for `ownerName === user.name`.
4. Group `user.hotbar` (slot → macroId) by macroId to collect all slots per macro.
5. For each unique macro on the hotbar:
   - Ensure `flags.omnipresence.id` is stamped on the local doc (write with `omnipresenceInternal: true` if missing).
   - Build compendium data: `macro.toObject()`, delete `_id` and `folder`, set `flags.omnipresence.{id, ownerName, hotbarSlots}`.
   - Upsert: update existing compendium entry if found by `(omnipresenceId, ownerName)`, otherwise `Macro.create(data, { pack: PACK_ID })`.
6. Delete compendium entries for this user whose `omnipresence.id` is no longer in the hotbar.

Debounce: 2 seconds per userId (same pattern as actor sync).

### Internal write guard

All writes by the module carry `{ omnipresenceInternal: true }`. The `updateMacro` and `updateUser` hooks check for this option and return early to prevent loops.

---

## 4. Pull Data Flow (on login)

`MacroSync.onLogin()` runs at the end of `SyncEngine.onLogin()`.

1. Bail if `!MacroSync.isOptedIn(game.user)`.
2. Load `omnipresence.omnipresence-macros`; filter to entries where `ownerName === game.user.name`.
3. Build a map of existing local macros by `flags.omnipresence.id`.
4. For each compendium entry:
   - Match to a local macro by `omnipresence.id`.
   - **If found:** `localMacro.update(compData, { omnipresenceInternal: true })` — always overwrite (no conflict detection for macros).
   - **If not found:** strip `_id` from `compData`, then `Macro.create(compData)` — macros get fresh world-local `_id`s.
   - Record `localMacroId → slots` mapping.
5. Merge all slot assignments into a single `game.user.update({ hotbar: newSlots }, { omnipresenceInternal: true })` call. Slots not covered by synced macros are left untouched.

---

## 5. Code Structure

### New files

| File | Purpose |
|---|---|
| `scripts/macro-sync.js` | `MacroSync` class: push/pull, debounce, opt-in checks |
| `scripts/user-config.js` | `renderUserConfig` hook injection; checkbox save-on-change |

### Changed files

| File | Change |
|---|---|
| `module.json` | Add `omnipresence-macros` pack entry |
| `scripts/sync-registry.js` | Register `omnipresence.syncPrefs` setting |
| `omnipresence.js` | Import `MacroSync`, `registerUserConfigInjection`; add `updateMacro`, `updateUser` hooks; add actor sync opt-in check to `updateActor` hook |
| `scripts/context-menu.js` | Wrap both menu items in actor sync opt-in check (`condition`) |
| `scripts/sync-engine.js` | Call `MacroSync.onLogin()` at end of `onLogin()`; bail early from actor reconciliation when actor sync is paused |

---

## 6. Key Invariants

- **`omnipresenceInternal: true` on every internal write** — prevents sync loops on `updateMacro` and `updateUser` hooks, same as existing pattern.
- **GM-write-only** — `MacroSync.pushForUser` bails immediately for non-GM clients.
- **Pause, not unenroll** — disabling actor sync hides UI and skips hooks but does not touch flags or registry.
- **Always-overwrite on pull** — no timestamp-based conflict detection for macros; the shared compendium copy always wins.
- **System-agnostic** — macro pack has no `system` field; macro sync works across all supported game systems.

---

## 7. Testing

No unit-testable pure logic is added. The primary test layer is automated browser tests via the Playwright MCP against a live Foundry instance, supplemented by a small number of manual-only checks.

**Environment:**
- Foundry Node: `/FoundryVTT/FoundryVTT-Node-13.351`
- Data directory: `~/FoundryVTT/Data`
- Module location: `~/FoundryVTT/Data/Data/modules/omnipresence`
- Worlds: `World A` and `World B` (both dnd5e)
- Start server: `~/FoundryVTT/start-foundry.command` → `http://localhost:30000`

### Automated tests (Playwright MCP)

Each test: start Foundry, navigate to `http://localhost:30000`, log in, run the scenario, assert via `page.evaluate()` against live Foundry state (`game.user.hotbar`, compendium contents, flags on documents).

| # | Scenario | Key assertion |
|---|---|---|
| 1 | **Hotbar push** — log in to World A as GM; create a chat macro; drag to slot 1; wait 2.5 s for debounce | `page.evaluate(() => game.packs.get('omnipresence.omnipresence-macros').getDocuments())` returns one entry with `flags.omnipresence.ownerName === user.name`, `hotbarSlots: [1]`, correct `name`/`command` |
| 2 | **Macro content update** — edit the macro's command in the macro editor | Compendium entry `command` field matches the new value |
| 3 | **Hotbar rearrange** — drag macro from slot 1 to slot 3 | Compendium entry `hotbarSlots` updates to `[3]` |
| 4 | **Macro removed from hotbar** — right-click slot, clear it | Compendium has zero entries for this user |
| 5 | **Cross-world pull** — with a compendium entry present, log out of World A and into World B | `game.user.hotbar` in World B contains a local macro ID in the correct slot; local macro `command` matches compendium |
| 6 | **Overwrite on pull** — in World B, open and edit the macro's command; log back into World A | After login, local macro command in World A matches the World A compendium version (World B edit is gone) |
| 7 | **Actor sync pause** — open User Config, uncheck "Synchronize player characters"; edit an enrolled actor | `game.packs.get(SyncEngine.PACK_ID).getDocuments()` shows the actor's `syncedAt` has not updated; context menu items absent from Actors Directory |
| 8 | **Macro sync pause** — uncheck "Synchronize hotbar macros"; drag a macro to a slot | Macro compendium still has zero entries (or unchanged) after 2.5 s |
| 9 | **Re-enable both toggles** — re-check both; log out and back in | Actor and macro sync resume; hotbar slots correct in World B |

### Manual-only checks

These require visual inspection and cannot be fully asserted via `page.evaluate()`:

- **User Config fieldset appearance** — verify the "Omnipresence" fieldset renders correctly in the dialog, with correct labels and default checked state
- **Script macro behavior in World B** — confirm script macros that reference World A entities appear on the hotbar but may fail to execute (expected; content is synced as-is)
- **Multi-page hotbar** — drag macros to page 2 slots (11–20) and verify they survive the cross-world round-trip
