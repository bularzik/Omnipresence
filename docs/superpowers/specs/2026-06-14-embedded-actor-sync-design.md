# Embedded Actor Data Sync — Design

**Date:** 2026-06-14
**Status:** Approved (pre-implementation)
**Scope:** Make actor sync include embedded data (inventory, spells, features, active effects, and effects nested on items). Also remove the `beforeunload` compendium-flush that races world shutdown.

## Problem

Omnipresence syncs enrolled player characters across worlds via a per-system
compendium. Today it only syncs **actor-level** changes:

- The sole sync trigger is the `updateActor` hook (`omnipresence.js:27`). In
  Foundry, inventory, spells, features, and buffs are **embedded documents** —
  `Item`s in `actor.items` and `ActiveEffect`s in `actor.effects`. Editing them
  fires `create/update/deleteItem` and `create/update/deleteActiveEffect`, never
  `updateActor`. So those edits never mark the actor dirty and never push.

- Even once a push is triggered, the apply side is broken: `pull()` and the
  "update existing compendium entry" branch of `push()` both rely on
  `Document#update(actorData)`. Foundry's `update()` does **not** reconcile
  embedded collections passed in a parent-level update — embedded docs must be
  created/updated/deleted through their own CRUD methods. So item/effect changes
  are silently dropped on apply.

A separate but related defect: on world shutdown the server logs

```
[error] Cannot read properties of undefined (reading 'packData')
    at ServerDatabaseBackend.modifyDocument (.../server-backend.mjs)
```

This is Omnipresence's `beforeunload` → `flushPending()` → `push()` emitting a
compendium `modifyDocument` socket request that races world teardown; the
server's pack registry is already gone, so the pack collection lookup returns
`undefined`. Our new feature amplifies this path (more frequent, larger pushes),
so it is fixed here.

## Goals

- Inventory, spells, features, active effects, and effects nested on items all
  propagate across worlds, in both directions.
- No regression to the existing whole-actor conflict model.
- Eliminate the shutdown `packData` error.
- Keep sync-decision logic pure and unit-testable, per existing architecture.

## Non-goals

- Per-item / per-effect conflict resolution or merge. Conflicts remain
  whole-actor and timestamp-based.
- De-duplicating characters that were independently created and enrolled in two
  worlds before any sync (see Known Limitations).

## Design

### 1. Trigger side — detect embedded changes

Add six hooks in `omnipresence.js`, mirroring the existing `updateActor`
handler:

- `createItem`, `updateItem`, `deleteItem`
- `createActiveEffect`, `updateActiveEffect`, `deleteActiveEffect`

Each handler:

1. Bail if `options?.omnipresenceInternal` — do not react to our own reconcile
   writes.
2. Resolve the owning actor via a new `SyncEngine.resolveOwningActor(doc)` that
   walks `doc.parent` upward until it reaches an `Actor` (handles the
   effect → item → actor chain, satisfying the "nested" scope). Returns `null`
   if no `Actor` ancestor.
3. Bail if no owning actor, or it is not enrolled (`SyncRegistry.isEnrolled`).
4. If `userId === game.user.id` → `SyncEngine.trackLocalModification(actor)`.
5. If `game.user.isGM` → `SyncEngine.debouncedPush(actor)`.

The existing `updateActor` handler is unchanged and stays for actor-level fields
(name, HP, system data). Because all paths go through the per-actor debounce
(`SyncEngine.debouncedPush`, keyed by `actor.id`), an edit that touches both an
item and actor data coalesces into a single push.

`resolveOwningActor` lives on `SyncEngine` (Foundry-dependent; references the
`Actor` class).

### 2. Apply side — reconcile embedded collections

**Pure diff (unit-testable, in `scripts/sync-logic.js`):**

```js
export function diffEmbedded(localDocs, snapshotDocs) {
  // Match by _id. Returns { toCreate, toUpdate, toDelete }.
  // toCreate: snapshot docs whose _id is absent locally (full data objects).
  // toDelete: local _ids absent from the snapshot.
  // toUpdate: docs present on both sides whose data differs (deep compare);
  //           unchanged docs are omitted to avoid churn.
}
```

`localDocs` / `snapshotDocs` are plain arrays of embedded-document data
(e.g. from `toObject()`), so the function has no Foundry dependency.

**Application (in `scripts/sync-engine.js`):**

`SyncEngine.reconcileActorEmbedded(targetActor, snapshotData)` makes
`targetActor`'s embedded collections match `snapshotData`'s. All CRUD calls pass
`{ omnipresenceInternal: true }` so the new hooks bail on our own writes.

- Reconcile `targetActor.items` against `snapshotData.items` using
  `diffEmbedded`:
  - `deleteEmbeddedDocuments('Item', toDelete)`
  - `createEmbeddedDocuments('Item', toCreate, { keepId: true, omnipresenceInternal: true })`
  - `updateEmbeddedDocuments('Item', toUpdate, { omnipresenceInternal: true })`
    — update payloads carry the item's own fields; the item's `effects` are
    handled by recursion, not by the parent update.
- **Recurse:** for each item present on both sides, reconcile that item's
  `effects` collection (ActiveEffects embedded in the Item) against the snapshot
  item's `effects`, via the item's own embedded CRUD.
- Reconcile `targetActor.effects` (actor-level ActiveEffects) the same way.

`keepId: true` on every create keeps embedded `_id`s stable across worlds, which
is what makes `_id` a valid cross-world match key — the same world-portability
philosophy behind stripping top-level `_id`/`ownership`/`folder`.

### 3. Wiring into push / pull

This also fixes the latent push bug (existing-entry updates never updated
embedded docs):

- **`pull(localActor, compActor)`**: update scalar/system fields as today, then
  `reconcileActorEmbedded(localActor, compData)`.
- **`push()` existing-entry branch**: update scalar fields on the compendium
  actor, then `reconcileActorEmbedded(existingCompActor, localSnapshot)`. (The
  local snapshot retains item `_id`s; `stripWorldLocalFields` only strips the
  top-level `_id`/`ownership`/`folder`.)
- **`push()` new-entry branch** and **auto-import** (`onLogin`):
  `Actor.create(actorData, { keepId: true, ... })` so embedded `_id`s are
  preserved from creation onward and converge across worlds. (The top-level
  actor `_id` was stripped, so a fresh actor `_id` is generated; only embedded
  ids are kept.)

### 4. Conflict handling — unchanged

Embedded edits bump the actor's `localModifiedAt` via
`trackLocalModification`. `decideSyncAction` and the existing conflict dialog
(`scripts/conflict-resolver.js`) operate at whole-actor granularity. No new
conflict UI.

### 5. Shutdown safety (fixes the `packData` error)

- **Remove** the `window.addEventListener('beforeunload', …)` listener
  (`omnipresence.js:46–48`) — the source of compendium writes racing world
  teardown.
- **Remove** the now-unused `SyncEngine.flushPending()` method and the
  `_pending` map (they existed only to support the unload flush).
  `debouncedPush` and `push` remain; they simply no longer maintain a `_pending`
  batch.
- Durability is preserved by the existing `trackLocalModification` marker: any
  edit not pushed before shutdown is detected by `decideSyncAction` at next
  login and pushed then. On a full world shutdown there are no other clients to
  benefit from an immediate flush, and pushes are GM-only regardless.

## Testing

**Unit (`tests/sync-logic.test.js`):** `diffEmbedded` cases —
- create-only (new snapshot doc)
- delete-only (local doc absent from snapshot)
- update (matched `_id`, changed data)
- no-op (matched `_id`, identical data → omitted from `toUpdate`)
- mixed batch (create + update + delete together)
- empty inputs on either side

**Manual / Playwright, two worlds sharing a system compendium:**
- Add an item → appears in the other world after sync.
- Edit item quantity / a system field → propagates.
- Delete an item → removed in the other world.
- Cast a spell (consume a slot / system resource change) → propagates.
- Add and remove an active effect / condition → propagates.
- Add an effect nested on an item → propagates.
- Shutdown check: make an edit, immediately return to setup; confirm **no**
  `packData` error in the server log, and the edit syncs on next login.

## Known limitations

- If the same character is independently created and enrolled in two worlds
  *before* any sync, their embedded `_id`s differ and matching by `_id` can
  produce duplicates. The normal master-origin + auto-import flow avoids this:
  non-origin worlds receive the actor (and its ids) via pull.

## Files touched

- `omnipresence.js` — add six embedded hooks; remove `beforeunload` listener.
- `scripts/sync-engine.js` — `resolveOwningActor`, `reconcileActorEmbedded`;
  wire reconcile into `pull`/`push`; `keepId` on creates & auto-import; remove
  `flushPending` and `_pending`.
- `scripts/sync-logic.js` — add pure `diffEmbedded`.
- `tests/sync-logic.test.js` — `diffEmbedded` unit tests.
