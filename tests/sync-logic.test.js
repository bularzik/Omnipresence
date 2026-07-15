import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSyncAction, stripWorldLocalFields, stripMacroLocalFields, diffEmbedded, resolveOwningActor, resolveOwningJournal, requiredModulesForJournal, worldLocalMediaPaths, deriveConflictState, isEnrolledFrom } from '../scripts/sync-logic.js';

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

test('stripMacroLocalFields removes _id, ownership, folder, and author', () => {
  const input = {
    _id: 'abc',
    name: 'Roll',
    author: 'user1',
    ownership: { default: 0, user1: 3 },
    folder: 'folder123',
    command: '/roll 1d20',
    flags: { omnipresence: { id: 'k' } }
  };
  const out = stripMacroLocalFields(input);
  assert.deepEqual(out, { name: 'Roll', command: '/roll 1d20', flags: { omnipresence: { id: 'k' } } });
});

test('stripMacroLocalFields does not mutate its input', () => {
  const input = { _id: 'abc', ownership: { user1: 3 }, folder: 'f1', author: 'user1', name: 'Roll' };
  stripMacroLocalFields(input);
  assert.equal(input._id, 'abc');
  assert.deepEqual(input.ownership, { user1: 3 });
  assert.equal(input.folder, 'f1');
  assert.equal(input.author, 'user1');
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

test('deriveConflictState: comp available, both sides changed → true', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T2, localModifiedAt: T1, compAvailable: true }),
    true
  );
});

test('deriveConflictState: comp available, only local changed → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: T1, compAvailable: true }),
    false
  );
});

test('deriveConflictState: comp available, only comp newer → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T2, localModifiedAt: T0, compAvailable: true }),
    false
  );
});

test('deriveConflictState: comp available, nothing changed → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: T0, compAvailable: true }),
    false
  );
});

test('deriveConflictState: comp unavailable, local edited since sync → true (fallback)', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: null, localModifiedAt: T1, compAvailable: false }),
    true
  );
});

test('deriveConflictState: comp unavailable, no local change → false (fallback)', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: null, localModifiedAt: T0, compAvailable: false }),
    false
  );
});

test('deriveConflictState: comp unavailable, missing localModifiedAt falls back to syncedAt → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: null, localModifiedAt: undefined, compAvailable: false }),
    false
  );
});

test('deriveConflictState: comp available, never synced locally (null localSyncedAt) + local edit → conflict iff comp also newer', () => {
  // localSyncedAt null → baseline epoch 0; comp has a real syncedAt (newer than 0)
  // and local was modified → both sides newer than baseline → conflict → true.
  assert.equal(
    deriveConflictState({ localSyncedAt: null, compSyncedAt: T1, localModifiedAt: T2, compAvailable: true }),
    true
  );
});

test('deriveConflictState: comp unavailable, never synced (null localSyncedAt), no local edit → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: null, compSyncedAt: null, localModifiedAt: undefined, compAvailable: false }),
    false
  );
});

test('resolveOwningJournal: page directly on a journal entry', () => {
  const journal = { documentName: 'JournalEntry', parent: null };
  const page = { documentName: 'JournalEntryPage', parent: journal };
  assert.equal(resolveOwningJournal(page), journal);
});

test('resolveOwningJournal: no journal ancestor → null', () => {
  const page = { documentName: 'JournalEntryPage', parent: { documentName: 'JournalEntryPage', parent: null } };
  assert.equal(resolveOwningJournal(page), null);
});

test('resolveOwningJournal: doc with no parent → null', () => {
  assert.equal(resolveOwningJournal({ documentName: 'JournalEntryPage', parent: null }), null);
});

test('resolveOwningActor still resolves after generalization', () => {
  const actor = { documentName: 'Actor', parent: null };
  const item = { documentName: 'Item', parent: actor };
  assert.equal(resolveOwningActor(item), actor);
});

test('requiredModulesForJournal: page-type prefixes become module ids', () => {
  const data = { pages: [{ type: 'campaign-record.npc' }, { type: 'text' }, { type: 'image' }] };
  assert.deepEqual(requiredModulesForJournal(data), ['campaign-record']);
});

test('requiredModulesForJournal: flag scopes on entry and pages (excluding core/omnipresence)', () => {
  const data = {
    flags: { core: { x: 1 }, omnipresence: { id: 'k' }, 'monks-enhanced-journal': { a: 1 } },
    pages: [{ type: 'text', flags: { 'campaign-record': { b: 2 } } }]
  };
  assert.deepEqual(requiredModulesForJournal(data), ['campaign-record', 'monks-enhanced-journal']);
});

test('requiredModulesForJournal: dedupes and sorts', () => {
  const data = {
    pages: [
      { type: 'campaign-record.npc' },
      { type: 'campaign-record.place', flags: { 'monks-enhanced-journal': {} } }
    ]
  };
  assert.deepEqual(requiredModulesForJournal(data), ['campaign-record', 'monks-enhanced-journal']);
});

test('requiredModulesForJournal: plain journal → empty', () => {
  const data = { flags: { core: {} }, pages: [{ type: 'text' }] };
  assert.deepEqual(requiredModulesForJournal(data), []);
});

test('worldLocalMediaPaths: collects page src under worlds/', () => {
  const data = { pages: [
    { type: 'image', src: 'worlds/world-a/art/map.jpg' },
    { type: 'image', src: 'modules/shared/x.png' },
    { type: 'image', src: 'https://example.com/y.png' },
    { type: 'text' }
  ] };
  assert.deepEqual(worldLocalMediaPaths(data), ['worlds/world-a/art/map.jpg']);
});

test('worldLocalMediaPaths: no media → empty', () => {
  assert.deepEqual(worldLocalMediaPaths({ pages: [{ type: 'text' }] }), []);
});

test('isEnrolledFrom: no id → false regardless of flag/registry', () => {
  assert.equal(isEnrolledFrom({ id: null, enrolledFlag: true, inRegistry: true }), false);
  assert.equal(isEnrolledFrom({ id: undefined, enrolledFlag: undefined, inRegistry: true }), false);
});

test('isEnrolledFrom: enrolled flag true → true', () => {
  assert.equal(isEnrolledFrom({ id: 'k', enrolledFlag: true, inRegistry: false }), true);
});

test('isEnrolledFrom: enrolled flag false wins over registry → false', () => {
  assert.equal(isEnrolledFrom({ id: 'k', enrolledFlag: false, inRegistry: true }), false);
});

test('isEnrolledFrom: no flag, in registry → true (legacy)', () => {
  assert.equal(isEnrolledFrom({ id: 'k', enrolledFlag: undefined, inRegistry: true }), true);
});

test('isEnrolledFrom: no flag, not in registry → false', () => {
  assert.equal(isEnrolledFrom({ id: 'k', enrolledFlag: undefined, inRegistry: false }), false);
});
