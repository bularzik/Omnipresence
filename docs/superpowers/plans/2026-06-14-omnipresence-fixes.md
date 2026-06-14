# Omnipresence Install Fix & Sync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the module install on Foundry v13 by giving each Actor compendium pack a `system`, and harden the sync engine so only GM-role clients write to compendiums and ownership is never corrupted on pull.

**Architecture:** Six per-system Actor compendium packs (one per supported system), resolved dynamically by `game.system.id`. All compendium writes are performed by GM-role clients; players only mark their actors "dirty" locally. World-local fields (`_id`, `ownership`, `folder`) are stripped whenever actor data crosses the shared compendium. Pure decision/stripping logic is extracted into a Foundry-independent module and unit-tested with Node's built-in test runner.

**Tech Stack:** Foundry VTT v13 module (ESM, browser globals: `game`, `Hooks`, `Actor`, `CONST`, `ui`, `foundry`). Node v26 built-in test runner (`node --test`, `node:assert`) for the pure logic. No third-party dependencies.

**Reference spec:** `docs/superpowers/specs/2026-06-14-omnipresence-fixes-design.md`

**Supported system IDs:** `dnd5e`, `pf2e`, `daggerheart`, `draw-steel`, `shadowdark`, `CoC7`

---

## File Structure

**New files:**
- `package.json` — marks the repo as ESM for Node tooling and defines the `test` script. Does not affect Foundry (which reads `module.json`).
- `scripts/sync-logic.js` — pure, Foundry-independent helpers: `decideSyncAction`, `stripWorldLocalFields`. No `game`/`Hooks`/`CONST` access.
- `tests/sync-logic.test.js` — unit tests for the pure helpers.
- `packs/omnipresence-<system>/.gitkeep` × 6 — empty pack directories Foundry populates on first write.

**Modified files:**
- `module.json` — replace single pack with six per-system packs; add `relationships.systems`.
- `scripts/sync-engine.js` — dynamic pack id, GM-write guard, decision logic via `sync-logic`, field stripping, flag guard.
- `omnipresence.js` — `updateActor` hook rewrite, `ready` unlock target, graceful disable.
- `scripts/context-menu.js` — jQuery/HTMLElement tolerance, hide entries when no pack.
- `scripts/gm-dashboard.js` — dynamic pack id in `_onForcePull`.
- `lang/en.json` — add the unsupported-system notification string.

**Removed:**
- `packs/omnipresence-actors/` — the old single pack directory.

---

## Task 1: Pure logic — `decideSyncAction` (TDD)

**Files:**
- Create: `package.json`
- Create: `scripts/sync-logic.js`
- Test: `tests/sync-logic.test.js`

- [ ] **Step 1: Create `package.json`** (required so Node treats `.js` as ESM when running tests)

```json
{
  "name": "omnipresence",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Write the failing test** — create `tests/sync-logic.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSyncAction } from '../scripts/sync-logic.js';

const T0 = '2026-06-14T10:00:00.000Z';
const T1 = '2026-06-14T11:00:00.000Z';
const T2 = '2026-06-14T12:00:00.000Z';

test('decideSyncAction: nothing changed → none', () => {
  assert.equal(
    decideSyncAction({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: T0 }),
    'none'
  );
});

test('decideSyncAction: local edited since last sync → push', () => {
  assert.equal(
    decideSyncAction({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: T1 }),
    'push'
  );
});

test('decideSyncAction: compendium newer, no local change → pull', () => {
  assert.equal(
    decideSyncAction({ localSyncedAt: T0, compSyncedAt: T2, localModifiedAt: T0 }),
    'pull'
  );
});

test('decideSyncAction: both sides changed → conflict', () => {
  assert.equal(
    decideSyncAction({ localSyncedAt: T0, compSyncedAt: T2, localModifiedAt: T1 }),
    'conflict'
  );
});

test('decideSyncAction: missing localModifiedAt falls back to localSyncedAt → none', () => {
  assert.equal(
    decideSyncAction({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: undefined }),
    'none'
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/sync-logic.test.js`
Expected: FAIL — `Cannot find module '.../scripts/sync-logic.js'` (file does not exist yet).

- [ ] **Step 4: Write the minimal implementation** — create `scripts/sync-logic.js`

```js
// Pure, Foundry-independent sync helpers.
// No access to game/Hooks/CONST/ui — safe to unit-test under plain Node.

/**
 * Decide what sync action an enrolled actor needs, from timestamps alone.
 * Inputs are ISO date strings or null/undefined.
 * @returns {'push'|'pull'|'conflict'|'none'}
 */
export function decideSyncAction({ localSyncedAt, compSyncedAt, localModifiedAt }) {
  const t = (iso) => (iso ? new Date(iso).getTime() : 0);
  const localSync = t(localSyncedAt);
  const compSync = t(compSyncedAt);
  const localMod = localModifiedAt ? t(localModifiedAt) : localSync;

  const localChanged = localMod > localSync;
  const compNewer = compSync > localSync;

  if (compNewer && localChanged) return 'conflict';
  if (compNewer) return 'pull';
  if (localChanged) return 'push';
  return 'none';
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/sync-logic.test.js`
Expected: PASS — 5 tests passing.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/sync-logic.js tests/sync-logic.test.js
git commit -m "$(printf 'feat: add decideSyncAction pure sync-decision helper\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 2: Pure logic — `stripWorldLocalFields` (TDD)

**Files:**
- Modify: `scripts/sync-logic.js`
- Test: `tests/sync-logic.test.js`

- [ ] **Step 1: Add the failing test** — append to `tests/sync-logic.test.js`

```js
import { stripWorldLocalFields } from '../scripts/sync-logic.js';

test('stripWorldLocalFields removes _id, ownership, and folder', () => {
  const input = {
    _id: 'abc',
    name: 'Hero',
    ownership: { default: 0, user1: 3 },
    folder: 'folder123',
    flags: { omnipresence: { id: 'k' } }
  };
  const out = stripWorldLocalFields(input);
  assert.deepEqual(out, { name: 'Hero', flags: { omnipresence: { id: 'k' } } });
});

test('stripWorldLocalFields does not mutate its input', () => {
  const input = { _id: 'abc', ownership: { user1: 3 }, folder: 'f1', name: 'Hero' };
  stripWorldLocalFields(input);
  assert.equal(input._id, 'abc');
  assert.deepEqual(input.ownership, { user1: 3 });
  assert.equal(input.folder, 'f1');
});
```

> Note: ES module imports are hoisted, so the second `import { stripWorldLocalFields }` line is fine alongside the existing `decideSyncAction` import; you may also merge them into one import statement.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/sync-logic.test.js`
Expected: FAIL — `stripWorldLocalFields is not a function` (export does not exist yet).

- [ ] **Step 3: Add the minimal implementation** — append to `scripts/sync-logic.js`

```js
const WORLD_LOCAL_KEYS = ['_id', 'ownership', 'folder'];

/**
 * Return a deep clone of actor data with world-local fields removed
 * (_id, ownership, folder). These reference IDs meaningless in any other
 * world, so they must never cross the shared compendium. Input is not mutated.
 */
export function stripWorldLocalFields(actorData) {
  const clone = structuredClone(actorData);
  for (const key of WORLD_LOCAL_KEYS) delete clone[key];
  return clone;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/sync-logic.test.js`
Expected: PASS — all tests (7 total) passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-logic.js tests/sync-logic.test.js
git commit -m "$(printf 'feat: add stripWorldLocalFields helper\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 3: `module.json` — per-system packs + relationships

**Files:**
- Modify: `module.json`
- Create: `packs/omnipresence-dnd5e/.gitkeep`, `packs/omnipresence-pf2e/.gitkeep`, `packs/omnipresence-daggerheart/.gitkeep`, `packs/omnipresence-draw-steel/.gitkeep`, `packs/omnipresence-shadowdark/.gitkeep`, `packs/omnipresence-CoC7/.gitkeep`
- Remove: `packs/omnipresence-actors/`

- [ ] **Step 1: Replace the `packs` array** in `module.json`

Replace the existing `"packs": [ ... ]` block with:

```json
  "packs": [
    { "name": "omnipresence-dnd5e",       "type": "Actor", "system": "dnd5e",       "path": "packs/omnipresence-dnd5e",       "label": "Omnipresence — D&D 5e" },
    { "name": "omnipresence-pf2e",        "type": "Actor", "system": "pf2e",        "path": "packs/omnipresence-pf2e",        "label": "Omnipresence — Pathfinder 2e" },
    { "name": "omnipresence-daggerheart", "type": "Actor", "system": "daggerheart", "path": "packs/omnipresence-daggerheart", "label": "Omnipresence — Daggerheart" },
    { "name": "omnipresence-draw-steel",  "type": "Actor", "system": "draw-steel",  "path": "packs/omnipresence-draw-steel",  "label": "Omnipresence — Draw Steel" },
    { "name": "omnipresence-shadowdark",  "type": "Actor", "system": "shadowdark",  "path": "packs/omnipresence-shadowdark",  "label": "Omnipresence — Shadowdark" },
    { "name": "omnipresence-CoC7",        "type": "Actor", "system": "CoC7",        "path": "packs/omnipresence-CoC7",        "label": "Omnipresence — Call of Cthulhu 7e" }
  ],
```

- [ ] **Step 2: Add `relationships.systems`** in `module.json`

Add this top-level key (e.g. directly after the `packs` array, before the closing `}`; ensure correct comma placement):

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

- [ ] **Step 3: Create the six pack directories and remove the old one**

Run:
```bash
rm -rf packs/omnipresence-actors
for s in dnd5e pf2e daggerheart draw-steel shadowdark CoC7; do
  mkdir -p "packs/omnipresence-$s"
  touch "packs/omnipresence-$s/.gitkeep"
done
ls packs/
```
Expected: lists the six `omnipresence-<system>` directories and no `omnipresence-actors`.

- [ ] **Step 4: Validate `module.json` is well-formed JSON**

Run: `python3 -m json.tool module.json > /dev/null && echo VALID`
Expected: `VALID` (no parse error).

- [ ] **Step 5: Commit**

```bash
git add module.json packs/
git commit -m "$(printf 'fix: declare per-system Actor packs to resolve install error\n\nReplaces the single system-less pack with six system-pinned packs and\nadds relationships.systems for the six supported systems.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 4: `lang/en.json` — unsupported-system string

**Files:**
- Modify: `lang/en.json`

- [ ] **Step 1: Add the notification key**

Add this entry to `lang/en.json` (e.g. after the existing `OMNIPRESENCE.notifications.unenrolled` line; ensure the preceding line ends with a comma):

```json
  "OMNIPRESENCE.notifications.unsupportedSystem": "Omnipresence: character sync is not available for the \"{system}\" game system."
```

- [ ] **Step 2: Validate JSON**

Run: `python3 -m json.tool lang/en.json > /dev/null && echo VALID`
Expected: `VALID`.

- [ ] **Step 3: Commit**

```bash
git add lang/en.json
git commit -m "$(printf 'feat: add unsupported-system notification string\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 5: `sync-engine.js` — dynamic pack id, GM-write guard, stripping, decision logic

**Files:**
- Modify: `scripts/sync-engine.js` (full rewrite of the file below)

- [ ] **Step 1: Replace the entire contents of `scripts/sync-engine.js`**

```js
import { SyncRegistry } from './sync-registry.js';
import { decideSyncAction, stripWorldLocalFields } from './sync-logic.js';

const DEBOUNCE_MS = 2000;

export class SyncEngine {
  static _timers = new Map();   // actorId → timeout handle
  static _pending = new Map();  // actorId → actor (for flush on logout)

  /** Compendium id for the active world's game system. */
  static get PACK_ID() {
    return `omnipresence.omnipresence-${game.system.id}`;
  }

  static _getPack() {
    return game.packs.get(this.PACK_ID);
  }

  static async _getCompendiumActor(omnipresenceId) {
    const pack = this._getPack();
    if (!pack) return null;
    const docs = await pack.getDocuments();
    return docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId) ?? null;
  }

  static async push(actor) {
    // Only GM-role clients can write to a module compendium.
    if (!game.user.isGM) return;

    const pack = this._getPack();
    if (!pack) {
      console.warn('Omnipresence | compendium pack not found:', this.PACK_ID);
      return;
    }

    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    if (!omnipresenceId) return;

    const syncedAt = new Date().toISOString();

    // Strip world-local fields (_id, ownership, folder) before writing to the shared compendium.
    const actorData = stripWorldLocalFields(actor.toObject());

    // Strip world-local sync metadata and stamp the shared syncedAt.
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    delete actorData.flags.omnipresence.localModifiedAt;
    actorData.flags.omnipresence.syncedAt = syncedAt;

    try {
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        await existing.update(actorData);
      } else {
        await Actor.create(actorData, { pack: this.PACK_ID });
      }

      // Update local syncedAt to match (do not touch localModifiedAt).
      await actor.update(
        { 'flags.omnipresence.syncedAt': syncedAt },
        { omnipresenceInternal: true }
      );

      this._pending.delete(actor.id);
    } catch (err) {
      console.error('Omnipresence | push failed for', actor.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: actor.name })
      );
    }
  }

  static debouncedPush(actor) {
    const id = actor.id;
    if (this._timers.has(id)) clearTimeout(this._timers.get(id));
    this._pending.set(id, actor);
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this.push(actor);
    }, DEBOUNCE_MS);
    this._timers.set(id, timer);
  }

  static async trackLocalModification(actor) {
    await actor.update(
      { 'flags.omnipresence.localModifiedAt': new Date().toISOString() },
      { omnipresenceInternal: true }
    );
  }

  static async flushPending() {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const [, timer] of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
    await Promise.all(pending.map(actor => this.push(actor)));
  }

  static async pull(localActor, compActor) {
    // Strip world-local fields so local ownership and folder are preserved.
    const actorData = stripWorldLocalFields(compActor.toObject());
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding).
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    await localActor.update(actorData, { omnipresenceInternal: true });
  }

  static async onLogin() {
    const pack = this._getPack();
    if (!pack) {
      if (game.user.isGM) {
        ui.notifications.info(
          game.i18n.format('OMNIPRESENCE.notifications.unsupportedSystem', { system: game.system.id })
        );
      }
      return;
    }

    const compActors = await pack.getDocuments();
    const myActors = game.actors.filter(a => a.isOwner && SyncRegistry.isEnrolled(a));

    // 1. Sync each of the current user's enrolled actors.
    for (const actor of myActors) {
      const omnipresenceId = actor.getFlag('omnipresence', 'id');
      const compActor = compActors.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);

      if (!compActor) {
        // No compendium entry — push local copy as master (GM only; no-op for players).
        await this.push(actor);
        continue;
      }

      const action = decideSyncAction({
        localSyncedAt: actor.getFlag('omnipresence', 'syncedAt'),
        compSyncedAt: compActor.getFlag('omnipresence', 'syncedAt'),
        localModifiedAt: actor.getFlag('omnipresence', 'localModifiedAt')
      });

      if (action === 'conflict') {
        const { ConflictResolver } = await import('./conflict-resolver.js');
        await ConflictResolver.resolve(actor, compActor, {
          onKeepLocal: () => this.push(actor),
          onUseShared: () => this.pull(actor, compActor)
        });
      } else if (action === 'pull') {
        await this.pull(actor, compActor);
      } else if (action === 'push') {
        await this.push(actor);
      }
      // 'none': in sync
    }

    // 2. Auto-import: compendium actors not present in this world (GM only).
    if (!game.user.isGM) return;
    const localOmnipresenceIds = new Set(
      game.actors
        .filter(a => SyncRegistry.isEnrolled(a))
        .map(a => a.getFlag('omnipresence', 'id'))
    );

    for (const compActor of compActors) {
      const omnipresenceId = compActor.getFlag('omnipresence', 'id');
      if (!omnipresenceId) continue;
      if (localOmnipresenceIds.has(omnipresenceId)) continue;

      const ownerName = compActor.getFlag('omnipresence', 'ownerName');
      if (!ownerName) {
        console.warn('Omnipresence | compendium actor has no ownerName, skipping auto-import:', compActor.name);
        continue;
      }

      const matchingUser = game.users.find(u => u.name === ownerName);
      if (!matchingUser) {
        console.warn('Omnipresence | no user named', ownerName, '— skipping auto-import of', compActor.name);
        continue;
      }

      const actorData = stripWorldLocalFields(compActor.toObject());
      actorData.flags ??= {};
      actorData.flags.omnipresence ??= {};
      actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
      actorData.ownership = { default: 0, [matchingUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

      const created = await Actor.create(actorData);
      await SyncRegistry.enroll(created);
    }
  }
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check scripts/sync-engine.js`
Expected: no output, exit code 0 (syntax valid). `node --check` parses without resolving imports or running browser globals.

- [ ] **Step 3: Re-run the unit tests** (sync-logic is now imported by sync-engine; confirm nothing in the pure module regressed)

Run: `node --test tests/sync-logic.test.js`
Expected: PASS — all tests passing.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-engine.js
git commit -m "$(printf 'fix: GM-only compendium writes, dynamic pack id, ownership strip\n\nResolves pack id by active system, gates all pack writes behind GM role,\nstrips world-local fields (_id/ownership/folder) on push and pull, and\nuses decideSyncAction for the login sync decision.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 6: `omnipresence.js` — hook rewrite, unlock target, graceful disable

**Files:**
- Modify: `omnipresence.js`

- [ ] **Step 1: Replace the `ready` hook** (currently unlocks the hardcoded pack id)

Replace the existing `Hooks.once('ready', ...)` block with:

```js
Hooks.once('ready', async () => {
  if (game.user.isGM) {
    const pack = game.packs.get(SyncEngine.PACK_ID);
    if (pack && pack.locked) await pack.configure({ locked: false });
  }
  await SyncEngine.onLogin();
});
```

- [ ] **Step 2: Replace the `updateActor` hook** with the GM-writes model

Replace the existing `Hooks.on('updateActor', ...)` block with:

```js
Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  // The editing user marks the actor dirty (they can write their own actor).
  if (userId === game.user.id) SyncEngine.trackLocalModification(actor);
  // A GM-role client performs the compendium write (only GMs can write packs).
  if (game.user.isGM) SyncEngine.debouncedPush(actor);
});
```

> The `deleteActor`, `beforeunload`, and `getActorDirectoryEntryContext` hooks, and the `init` hook, are unchanged.

- [ ] **Step 3: Verify syntax**

Run: `node --check omnipresence.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add omnipresence.js
git commit -m "$(printf 'fix: GM performs compendium writes; unlock active-system pack\n\nEditing user marks the actor dirty; a GM-role client performs the push.\nReady hook unlocks the per-system pack resolved by SyncEngine.PACK_ID.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 7: `context-menu.js` — jQuery/HTMLElement tolerance + disable when no pack

**Files:**
- Modify: `scripts/context-menu.js` (full rewrite below)

- [ ] **Step 1: Replace the entire contents of `scripts/context-menu.js`**

```js
import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';

/**
 * Resolve the actor document id from a context-menu target that may be a
 * jQuery object (v12 / early v13) or a native HTMLElement (v13 ApplicationV2).
 */
function getDocumentId(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  if (el?.dataset?.documentId) return el.dataset.documentId;
  if (typeof li?.data === 'function') return li.data('documentId');
  return null;
}

/** Sync is available only when a compendium pack exists for the active system. */
function syncAvailable() {
  return !!game.packs.get(SyncEngine.PACK_ID);
}

export function registerContextMenu(entryOptions) {
  entryOptions.push(
    {
      name: 'OMNIPRESENCE.contextMenu.add',
      icon: '<i class="fas fa-link"></i>',
      condition: (li) => {
        if (!syncAvailable()) return false;
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return !SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return;
        await SyncRegistry.enroll(actor);
        await SyncEngine.push(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.enrolled', { name: actor.name }));
      }
    },
    {
      name: 'OMNIPRESENCE.contextMenu.remove',
      icon: '<i class="fas fa-unlink"></i>',
      condition: (li) => {
        if (!syncAvailable()) return false;
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return;
        await SyncRegistry.unenroll(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
      }
    }
  );
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check scripts/context-menu.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/context-menu.js
git commit -m "$(printf 'fix: tolerate native HTMLElement in context menu; hide when no pack\n\nResolves the document id from either a jQuery object or a native element\n(v13 ApplicationV2 directory) and hides enroll/unenroll when the active\nsystem has no Omnipresence pack.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 8: `gm-dashboard.js` — dynamic pack id in force-pull

**Files:**
- Modify: `scripts/gm-dashboard.js`

- [ ] **Step 1: Replace the hardcoded pack id in `_onForcePull`**

In `scripts/gm-dashboard.js`, inside `_onForcePull`, replace:

```js
    const pack = game.packs.get('omnipresence.omnipresence-actors');
```

with:

```js
    const pack = game.packs.get(SyncEngine.PACK_ID);
```

> `SyncEngine` is already imported at the top of this file. No other change is needed; `_onForcePush`, `_onRemoveSync`, and `_onForceSyncAll` already delegate to `SyncEngine`, which now resolves the pack dynamically and enforces the GM-write guard.

- [ ] **Step 2: Verify syntax**

Run: `node --check scripts/gm-dashboard.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/gm-dashboard.js
git commit -m "$(printf 'fix: resolve dashboard force-pull pack by active system\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Task 9: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit-test suite**

Run: `node --test`
Expected: PASS — all `tests/*.test.js` passing (7 tests).

- [ ] **Step 2: Syntax-check every module file**

Run:
```bash
for f in omnipresence.js scripts/sync-engine.js scripts/sync-logic.js scripts/context-menu.js scripts/gm-dashboard.js scripts/sync-registry.js scripts/conflict-resolver.js; do
  node --check "$f" && echo "OK  $f"
done
```
Expected: `OK` for every file, exit code 0.

- [ ] **Step 3: Validate JSON manifests**

Run: `python3 -m json.tool module.json > /dev/null && python3 -m json.tool lang/en.json > /dev/null && echo VALID`
Expected: `VALID`.

- [ ] **Step 4: Install the module into the local Foundry test instance**

A real, licensed Foundry v13.351 (Node variant) is available for verification:
- Install: `/Users/danbularzik/Desktop/Foundry/FoundryVTT-Node-13.351` (launch with `node main.js`)
- Data dir: `/Users/danbularzik/Desktop/Foundry/Foundry-Data` (already set as `dataPath` in `Config/options.json`; serves on port 30000)
- Installed system: **`dnd5e` only**. Test worlds: **`world-a`** and **`world-b`** (both dnd5e 13.351) for cross-world sync.

Install by copying the repo into the data dir's modules folder (copy, not symlink, to keep the repo working tree clean of Foundry's LevelDB writes). Re-run this command after any code fix:

```bash
DEST=/Users/danbularzik/Desktop/Foundry/Foundry-Data/Data/modules/omnipresence
rm -rf "$DEST"
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'docs' --exclude '.beads' \
  --exclude '.superpowers' --exclude '.remember' --exclude '.agents' --exclude '.codex' \
  --exclude '.claude' --exclude 'tests' --exclude '.DS_Store' \
  /Users/danbularzik/Desktop/Claude/Projects/Omnipresence/ "$DEST/"
ls "$DEST/module.json" && echo INSTALLED
```
Expected: `INSTALLED`.

- [ ] **Step 5: Launch Foundry (background) and confirm it serves**

Run (background process):
```bash
cd /Users/danbularzik/Desktop/Foundry/FoundryVTT-Node-13.351 && node main.js
```
Then confirm it is up: `curl -sf http://localhost:30000/ -o /dev/null && echo UP`
Expected: `UP`. Drive the UI with the Playwright MCP at `http://localhost:30000`.

- [ ] **Step 6: Runnable verification on dnd5e** (drive via Playwright; record pass/fail per item)

  - [ ] Launch `world-a` as Gamemaster; enable the Omnipresence module if not already; confirm **no "pack must declare system" error** and no console errors at load.
  - [ ] Confirm the `omnipresence.omnipresence-dnd5e` compendium is present in the Compendium Packs sidebar.
  - [ ] Right-click an actor in the Actors Directory → "Add to Omnipresence Sync" appears; click it → enrolled notification; the actor appears in the dnd5e compendium.
  - [ ] Edit that actor (e.g. change a value/HP) as GM → within ~2s the compendium copy updates (re-open it to confirm).
  - [ ] In `world-b` (dnd5e), launch as GM → the enrolled actor **auto-imports** (matched by owner name); confirm its **ownership and folder are correct/preserved**, not foreign IDs from world-a.
  - [ ] Edit the actor in `world-b`, then return to `world-a` and relaunch → the newer shared version **pulls** in; confirm ownership/folder again unchanged.
  - [ ] Force conflicting edits (edit in both worlds without syncing between) → on next login the **conflict dialog** appears; pressing Esc makes no change.
  - [ ] Inspect the compendium actor's source data → confirm `_id`, `ownership`, and `folder` are **absent** from what was written (the stripping works).

- [ ] **Step 7: Scope note — checks that need additional systems**

These spec items cannot be fully verified on this instance because only `dnd5e` is installed. Record as **not-verified-here** (not as failures) unless the corresponding systems are installed first:
  - Cross-system isolation (a dnd5e world never lists pf2e actors, etc.).
  - Behavior in an unsupported system (graceful-disable notice / module not enableable).

If verification of these is required, install one extra system (e.g. `pf2e`) plus a world using it, then repeat the relevant checks.

- [ ] **Step 8: Shut down and report**

Stop the Foundry background process. Summarize: automated checks (unit tests, syntax, JSON), the dnd5e runtime results from Step 6, and the not-verified-here items from Step 7. Per the repository's conservative git profile, do **not** push without explicit user approval.

---

## Notes for the implementer

- **Browser globals** (`game`, `Hooks`, `Actor`, `CONST`, `ui`, `foundry`) exist only in the Foundry runtime; `node --check` validates syntax without them. Integration behavior (Tasks 5–8) is verified for real against the local Foundry v13.351 instance in Task 9 (dnd5e / `world-a` ↔ `world-b`).
- **`structuredClone`** is available both in Node v26 and Foundry's browser environment.
- **Do not** add `relationships.requires` for the systems — that would force all six systems to be installed. `relationships.systems` is "compatible with any of these," which is what we want.
- **Known limitations** (by design, not bugs): no live cross-world propagation; player edits made with no GM connected wait for the next GM login; cross-world owner matching is by user display name.
