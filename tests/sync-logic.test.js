import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideSyncAction, stripWorldLocalFields } from '../scripts/sync-logic.js';

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
