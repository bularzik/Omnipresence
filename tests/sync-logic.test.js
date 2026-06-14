import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSyncAction, stripWorldLocalFields, diffEmbedded, resolveOwningActor } from '../scripts/sync-logic.js';

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

test('diffEmbedded: array-valued field equal → no-op', () => {
  const doc = { _id: 'a', system: { tags: ['fire', 'cold'] } };
  const out = diffEmbedded([structuredClone(doc)], [structuredClone(doc)]);
  assert.deepEqual(out, { toCreate: [], toUpdate: [], toDelete: [] });
});

test('diffEmbedded: array-valued field changed → toUpdate', () => {
  const out = diffEmbedded(
    [{ _id: 'a', system: { tags: ['fire'] } }],
    [{ _id: 'a', system: { tags: ['fire', 'cold'] } }]
  );
  assert.deepEqual(out.toUpdate, [{ _id: 'a', system: { tags: ['fire', 'cold'] } }]);
});

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
