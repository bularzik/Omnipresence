# Embedded Actor Data Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Omnipresence sync embedded actor data (inventory, spells, features, active effects, and effects nested on items) across worlds, and remove the `beforeunload` compendium flush that races world shutdown.

**Architecture:** Two new *pure* functions in `scripts/sync-logic.js` (`diffEmbedded`, `resolveOwningActor`) carry all the testable logic. `scripts/sync-engine.js` gains a Foundry-facing `reconcileActorEmbedded` that applies a diff via embedded-document CRUD, plus a `handleEmbeddedChange` dispatcher. Six new hooks in `omnipresence.js` route embedded-document changes to the owning enrolled actor's debounced push. The `beforeunload` flush and its `_pending`/`flushPending` machinery are removed.

**Tech Stack:** Foundry VTT v13 module (ES modules, browser runtime). Unit tests run under Node's built-in test runner (`node --test`). Pure logic in `sync-logic.js` must avoid any `node:` imports because that file also loads in the browser.

---

## Reference: design

Spec: `docs/superpowers/specs/2026-06-14-embedded-actor-sync-design.md`

## File structure

- `scripts/sync-logic.js` — pure, Foundry-independent. Add `diffEmbedded` and `resolveOwningActor`. (Existing: `decideSyncAction`, `stripWorldLocalFields`.)
- `scripts/sync-engine.js` — Foundry-facing. Add `reconcileActorEmbedded`, `_reconcileCollection`, `handleEmbeddedChange`. Wire reconcile into `pull`/`push`. Add `keepId` to creates. Remove `flushPending` + `_pending`.
- `omnipresence.js` — register six embedded hooks; remove the `beforeunload` listener.
- `tests/sync-logic.test.js` — unit tests for `diffEmbedded` and `resolveOwningActor`.

> **Note on Foundry-dependent tasks (3–6):** `node --test` cannot exercise code that touches Foundry globals (`game`, `Actor`, embedded CRUD). For those tasks the automated check is "`npm test` still passes" (no regression in pure tests); behavior is confirmed in Task 7's manual matrix.

---

### Task 1: Pure `diffEmbedded`

**Files:**
- Modify: `scripts/sync-logic.js`
- Test: `tests/sync-logic.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync-logic.test.js`:

```js
import { diffEmbedded } from '../scripts/sync-logic.js';

test('diffEmbedded: snapshot-only doc → toCreate', () => {
  const out = diffEmbedded([], [{ _id: 'a', name: 'Sword' }]);
  assert.deepEqual(out.toCreate, [{ _id: 'a', name: 'Sword' }]);
  assert.deepEqual(out.toUpdate, []);
  assert.deepEqual(out.toDelete, []);
});

test('diffEmbedded: local-only doc → toDelete', () => {
  const out = diffEmbedded([{ _id: 'a', name: 'Sword' }], []);
  assert.deepEqual(out.toDelete, ['a']);
  assert.deepEqual(out.toCreate, []);
  assert.deepEqual(out.toUpdate, []);
});

test('diffEmbedded: matched id, changed data → toUpdate (full snapshot obj)', () => {
  const out = diffEmbedded(
    [{ _id: 'a', name: 'Sword', system: { quantity: 1 } }],
    [{ _id: 'a', name: 'Sword', system: { quantity: 2 } }]
  );
  assert.deepEqual(out.toUpdate, [{ _id: 'a', name: 'Sword', system: { quantity: 2 } }]);
  assert.deepEqual(out.toCreate, []);
  assert.deepEqual(out.toDelete, []);
});

test('diffEmbedded: matched id, identical data → no-op', () => {
  const doc = { _id: 'a', name: 'Sword', system: { quantity: 1 } };
  const out = diffEmbedded([structuredClone(doc)], [structuredClone(doc)]);
  assert.deepEqual(out, { toCreate: [], toUpdate: [], toDelete: [] });
});

test('diffEmbedded: mixed create + update + delete', () => {
  const local = [
    { _id: 'keep', name: 'A', v: 1 },
    { _id: 'gone', name: 'B', v: 1 }
  ];
  const snap = [
    { _id: 'keep', name: 'A', v: 2 },
    { _id: 'new', name: 'C', v: 1 }
  ];
  const out = diffEmbedded(local, snap);
  assert.deepEqual(out.toDelete, ['gone']);
  assert.deepEqual(out.toCreate, [{ _id: 'new', name: 'C', v: 1 }]);
  assert.deepEqual(out.toUpdate, [{ _id: 'keep', name: 'A', v: 2 }]);
});

test('diffEmbedded: empty inputs → empty result', () => {
  assert.deepEqual(diffEmbedded([], []), { toCreate: [], toUpdate: [], toDelete: [] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `diffEmbedded` is not exported (`SyntaxError`/`TypeError: diffEmbedded is not a function`).

- [ ] **Step 3: Implement `diffEmbedded`**

Append to `scripts/sync-logic.js`:

```js
// Foundry-independent deep equality for plain data objects (no node: imports —
// this file also runs in the browser).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Diff two arrays of embedded-document data by `_id`.
 * @returns {{toCreate: object[], toUpdate: object[], toDelete: string[]}}
 *   toCreate/toUpdate are full snapshot objects; toDelete is a list of _ids.
 *   Docs present on both sides with identical data are omitted.
 */
export function diffEmbedded(localDocs, snapshotDocs) {
  const localById = new Map(localDocs.map(d => [d._id, d]));
  const snapById = new Map(snapshotDocs.map(d => [d._id, d]));

  const toDelete = [];
  for (const id of localById.keys()) {
    if (!snapById.has(id)) toDelete.push(id);
  }

  const toCreate = [];
  const toUpdate = [];
  for (const [id, snap] of snapById) {
    const local = localById.get(id);
    if (!local) toCreate.push(snap);
    else if (!deepEqual(local, snap)) toUpdate.push(snap);
  }

  return { toCreate, toUpdate, toDelete };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `diffEmbedded` tests green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-logic.js tests/sync-logic.test.js
git commit -m "feat: add pure diffEmbedded for embedded-collection reconcile"
```

---

### Task 2: Pure `resolveOwningActor`

**Files:**
- Modify: `scripts/sync-logic.js`
- Test: `tests/sync-logic.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync-logic.test.js`:

```js
import { resolveOwningActor } from '../scripts/sync-logic.js';

test('resolveOwningActor: item directly on actor', () => {
  const actor = { documentName: 'Actor', parent: null };
  const item = { documentName: 'Item', parent: actor };
  assert.equal(resolveOwningActor(item), actor);
});

test('resolveOwningActor: effect on actor', () => {
  const actor = { documentName: 'Actor', parent: null };
  const effect = { documentName: 'ActiveEffect', parent: actor };
  assert.equal(resolveOwningActor(effect), actor);
});

test('resolveOwningActor: effect nested on item nested on actor', () => {
  const actor = { documentName: 'Actor', parent: null };
  const item = { documentName: 'Item', parent: actor };
  const effect = { documentName: 'ActiveEffect', parent: item };
  assert.equal(resolveOwningActor(effect), actor);
});

test('resolveOwningActor: no actor ancestor → null', () => {
  const item = { documentName: 'Item', parent: { documentName: 'Item', parent: null } };
  assert.equal(resolveOwningActor(item), null);
});

test('resolveOwningActor: doc with no parent → null', () => {
  assert.equal(resolveOwningActor({ documentName: 'Item', parent: null }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveOwningActor is not a function`.

- [ ] **Step 3: Implement `resolveOwningActor`**

Append to `scripts/sync-logic.js`:

```js
/**
 * Walk an embedded document's parent chain to the owning Actor.
 * Uses `documentName` (a data property) so it stays Foundry-independent and
 * unit-testable. Returns the Actor document, or null if there is no Actor
 * ancestor. The passed document itself is never considered (start at parent).
 */
export function resolveOwningActor(doc) {
  let node = doc?.parent ?? null;
  while (node) {
    if (node.documentName === 'Actor') return node;
    node = node.parent ?? null;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `resolveOwningActor` tests green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-logic.js tests/sync-logic.test.js
git commit -m "feat: add pure resolveOwningActor parent-chain walk"
```

---

### Task 3: `reconcileActorEmbedded` in the sync engine

**Files:**
- Modify: `scripts/sync-engine.js`

> Foundry-dependent. Automated check: `npm test` still passes. Behavior verified in Task 7.

- [ ] **Step 1: Import the new pure helpers**

In `scripts/sync-engine.js`, change the existing import (line 2):

```js
import { decideSyncAction, stripWorldLocalFields } from './sync-logic.js';
```

to:

```js
import {
  decideSyncAction,
  stripWorldLocalFields,
  diffEmbedded,
  resolveOwningActor
} from './sync-logic.js';
```

- [ ] **Step 2: Add the reconcile methods**

Add these two static methods to the `SyncEngine` class (place them just above `static async pull(...)`):

```js
/**
 * Apply create/update/delete to one embedded collection so it matches
 * `snapshotDocs`. All writes carry omnipresenceInternal so the embedded
 * hooks ignore them. Creates use keepId so embedded _ids stay stable across
 * worlds (the cross-world match key).
 */
static async _reconcileCollection(parent, embeddedName, snapshotDocs) {
  const collection = parent.getEmbeddedCollection(embeddedName);
  const localDocs = collection.map(d => d.toObject());
  const { toCreate, toUpdate, toDelete } = diffEmbedded(localDocs, snapshotDocs ?? []);

  if (toDelete.length) {
    await parent.deleteEmbeddedDocuments(embeddedName, toDelete, { omnipresenceInternal: true });
  }
  if (toCreate.length) {
    await parent.createEmbeddedDocuments(embeddedName, toCreate, {
      keepId: true,
      omnipresenceInternal: true
    });
  }
  if (toUpdate.length) {
    await parent.updateEmbeddedDocuments(embeddedName, toUpdate, { omnipresenceInternal: true });
  }
}

/**
 * Make targetActor's embedded data (items, their nested effects, and
 * actor-level effects) match snapshotData. snapshotData is plain actor data
 * (e.g. from toObject()) whose embedded _ids are preserved.
 */
static async reconcileActorEmbedded(targetActor, snapshotData) {
  // 1. Items (inventory, spells, features).
  await this._reconcileCollection(targetActor, 'Item', snapshotData.items ?? []);

  // 2. Effects nested on items. Re-read items after the Item reconcile so newly
  //    created items are included (their effects self-heal if keepId did not
  //    carry to nested docs).
  const snapItemsById = new Map((snapshotData.items ?? []).map(i => [i._id, i]));
  for (const item of targetActor.items) {
    const snapItem = snapItemsById.get(item.id);
    if (!snapItem) continue;
    await this._reconcileCollection(item, 'ActiveEffect', snapItem.effects ?? []);
  }

  // 3. Actor-level effects (buffs, conditions).
  await this._reconcileCollection(targetActor, 'ActiveEffect', snapshotData.effects ?? []);
}
```

- [ ] **Step 3: Verify no regression**

Run: `npm test`
Expected: PASS — existing unit tests still green (no behavior wired in yet).

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-engine.js
git commit -m "feat: add reconcileActorEmbedded for embedded-collection sync"
```

---

### Task 4: Wire reconcile into push, pull, and creates

**Files:**
- Modify: `scripts/sync-engine.js`

> Foundry-dependent. Automated check: `npm test` still passes. Behavior verified in Task 7.

- [ ] **Step 1: Reconcile when updating an existing compendium entry + keepId on create**

In `push()`, replace the existing create/update branch (currently `sync-engine.js:51-56`):

```js
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        await existing.update(actorData);
      } else {
        await Actor.create(actorData, { pack: this.PACK_ID });
      }
```

with:

```js
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        await existing.update(actorData);
        await this.reconcileActorEmbedded(existing, actorData);
      } else {
        await Actor.create(actorData, { pack: this.PACK_ID, keepId: true });
      }
```

- [ ] **Step 2: Reconcile after a pull**

In `pull()`, replace the final update line (currently `sync-engine.js:108`):

```js
    await localActor.update(actorData, { omnipresenceInternal: true });
```

with:

```js
    await localActor.update(actorData, { omnipresenceInternal: true });
    await this.reconcileActorEmbedded(localActor, actorData);
```

- [ ] **Step 3: keepId on auto-import**

In `onLogin()`, replace the auto-import create (currently `sync-engine.js:187`):

```js
      const created = await Actor.create(actorData);
```

with:

```js
      const created = await Actor.create(actorData, { keepId: true });
```

- [ ] **Step 4: Verify no regression**

Run: `npm test`
Expected: PASS — existing unit tests still green.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-engine.js
git commit -m "feat: reconcile embedded data on push/pull; keepId on creates"
```

---

### Task 5: Embedded-change hooks

**Files:**
- Modify: `scripts/sync-engine.js`
- Modify: `omnipresence.js`

> Foundry-dependent. Automated check: `npm test` still passes. Behavior verified in Task 7.

- [ ] **Step 1: Add the dispatcher to SyncEngine**

Add this static method to `SyncEngine` (place it just below `trackLocalModification`). `resolveOwningActor` and `SyncRegistry` are already imported in this file (the latter at line 1):

```js
/**
 * Route an embedded-document change to the owning enrolled actor: mark dirty
 * (editing user) and debounce a push (GM). Mirrors the updateActor handler.
 */
static handleEmbeddedChange(doc, options, userId) {
  if (options?.omnipresenceInternal) return;
  const actor = resolveOwningActor(doc);
  if (!actor) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  if (userId === game.user.id) this.trackLocalModification(actor);
  if (game.user.isGM) this.debouncedPush(actor);
}
```

- [ ] **Step 2: Register the six hooks**

In `omnipresence.js`, add after the existing `getActorDirectoryEntryContext` hook block (currently ends at `omnipresence.js:52`):

```js
// Embedded-document changes (inventory, spells, features, effects, and effects
// nested on items) do not fire updateActor — route them to the owning actor.
// create/delete hooks fire (doc, options, userId); update fires
// (doc, changes, options, userId), so userId arrives in different positions.
const onEmbeddedCreateDelete = (doc, options, userId) =>
  SyncEngine.handleEmbeddedChange(doc, options, userId);
const onEmbeddedUpdate = (doc, changes, options, userId) =>
  SyncEngine.handleEmbeddedChange(doc, options, userId);

for (const hook of ['createItem', 'deleteItem', 'createActiveEffect', 'deleteActiveEffect']) {
  Hooks.on(hook, onEmbeddedCreateDelete);
}
for (const hook of ['updateItem', 'updateActiveEffect']) {
  Hooks.on(hook, onEmbeddedUpdate);
}
```

- [ ] **Step 3: Verify no regression**

Run: `npm test`
Expected: PASS — existing unit tests still green.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-engine.js omnipresence.js
git commit -m "feat: trigger sync on embedded item/effect changes"
```

---

### Task 6: Remove the beforeunload flush

**Files:**
- Modify: `omnipresence.js`
- Modify: `scripts/sync-engine.js`

> Foundry-dependent. Automated check: `npm test` still passes. Behavior verified in Task 7.

- [ ] **Step 1: Remove the beforeunload listener**

In `omnipresence.js`, delete this block (currently `omnipresence.js:44-48`):

```js
// Best-effort flush — browser does not await async handlers on unload.
// Edits made within the 2s debounce window at logout may not sync.
window.addEventListener('beforeunload', () => {
  SyncEngine.flushPending();
});
```

- [ ] **Step 2: Remove the `_pending` map and `flushPending`**

In `scripts/sync-engine.js`:

Delete the `_pending` field (currently `sync-engine.js:8`):

```js
  static _pending = new Map();  // actor → actor (for flush on logout)
```

In `push()`, delete the line that clears it (currently `sync-engine.js:64`):

```js
      this._pending.delete(actor.id);
```

In `debouncedPush()`, delete the line that sets it (currently `sync-engine.js:75`):

```js
    this._pending.set(id, actor);
```

Delete the entire `flushPending()` method (currently `sync-engine.js:91-99`):

```js
  static async flushPending() {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const [, timer] of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
    await Promise.all(pending.map(actor => this.push(actor)));
  }
```

> Leave `_timers` and the rest of `debouncedPush` intact — debouncing during normal play is unchanged.

- [ ] **Step 3: Verify no dangling references**

Run: `grep -rn "flushPending\|_pending" omnipresence.js scripts/`
Expected: no matches.

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add omnipresence.js scripts/sync-engine.js
git commit -m "fix: drop beforeunload compendium flush that raced world shutdown"
```

---

### Task 7: Two-world verification

**Files:** none (manual / Playwright verification).

> Requires a running Foundry v13 instance with two worlds on the same supported
> system (e.g. dnd5e), each sharing the Omnipresence compendium, and an enrolled
> character present in both. Reuse the Playwright flow established in prior
> Omnipresence verification sessions.

- [ ] **Step 1: Inventory create/update/delete**

In world A, on the enrolled character: add an item, change its quantity, then
log world B in (or trigger its login sync). Confirm the item appears, the
quantity matches, then delete it in A and confirm it disappears in B.

- [ ] **Step 2: Spell / resource use**

In world A, cast a spell or otherwise consume a system resource on the
character. Confirm the slot/resource change propagates to world B.

- [ ] **Step 3: Active effects (actor-level and nested)**

In world A, add then remove an active effect / condition on the actor; confirm
both propagate to B. Add an item that carries its own effect; confirm the item
and its nested effect appear in B.

- [ ] **Step 4: Conflict still works**

Edit the same character in both worlds while offline from sync, then sync;
confirm the existing whole-actor conflict dialog appears and "keep local" /
"use shared" behave correctly (including embedded data).

- [ ] **Step 5: Shutdown error gone**

Make an item edit on the character, then immediately return Foundry to setup
(world shutdown). Inspect the server log: confirm **no**
`Cannot read properties of undefined (reading 'packData')` error. Re-launch the
world and confirm the edit synced on next login (via the persisted
`localModifiedAt` marker).

- [ ] **Step 6: Final regression**

Run: `npm test`
Expected: PASS — full unit suite green.
