import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptAllowed } from '../scripts/security-logic.js';

// A player's own client created or re-keyed this document (live import, link,
// merge follow). The active GM binds it only when it is that player's own
// shared character and nothing else here holds the id.
const ok = {
  binding: null,
  boundDocCarriesId: false,
  copy: { exists: true, ownerName: 'Alice', mergedInto: null },
  docOwner: { name: 'Alice', isGM: false },
  selected: true,
  enrolled: true,
  otherCarrier: false
};

test('adoptAllowed: a player\'s own shared character, picked and owned, nothing else holding the id', () => {
  assert.equal(adoptAllowed(ok), true);
});

test('adoptAllowed: refuses a copy recorded for another player', () => {
  assert.equal(adoptAllowed({ ...ok, copy: { ...ok.copy, ownerName: 'Bob' } }), false);
});

test('adoptAllowed: refuses a GM-owned copy (no ownerName)', () => {
  assert.equal(adoptAllowed({ ...ok, copy: { ...ok.copy, ownerName: null } }), false);
});

test('adoptAllowed: refuses when the document has no player owner, or the owner is a GM', () => {
  assert.equal(adoptAllowed({ ...ok, docOwner: null }), false);
  assert.equal(adoptAllowed({ ...ok, docOwner: { name: 'Alice', isGM: true } }), false);
});

test('adoptAllowed: refuses when there is no shared copy, or it is a merge stub', () => {
  assert.equal(adoptAllowed({ ...ok, copy: { ...ok.copy, exists: false } }), false);
  assert.equal(adoptAllowed({ ...ok, copy: { ...ok.copy, mergedInto: 'x2' } }), false);
});

test('adoptAllowed: refuses when the id is not on the player\'s list or the document is not enrolled', () => {
  assert.equal(adoptAllowed({ ...ok, selected: false }), false);
  assert.equal(adoptAllowed({ ...ok, enrolled: false }), false);
});

test('adoptAllowed: refuses when another local document carries the id', () => {
  assert.equal(adoptAllowed({ ...ok, otherCarrier: true }), false);
});

test('adoptAllowed: a live binding to another document still carrying the id refuses; a stale one does not', () => {
  assert.equal(adoptAllowed({ ...ok, binding: { type: 'Actor', id: 'a9' }, boundDocCarriesId: true }), false);
  assert.equal(adoptAllowed({ ...ok, binding: { type: 'Actor', id: 'a9' }, boundDocCarriesId: false }), true);
});
