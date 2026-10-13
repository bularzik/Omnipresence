import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePushBinding, buildBindings, resolveDuplicateBindings, boundOmniToLocal, validateFolderRemoval
} from '../scripts/security-logic.js';

// --- Shared-copy bindings ---------------------------------------------------

test('decidePushBinding: bound to this doc → proceed (also after an unenroll/re-enroll)', () => {
  assert.equal(decidePushBinding({ binding: { type: 'Actor', id: 'a1' }, docType: 'Actor', docId: 'a1', copyExists: true }), 'proceed');
});

test('decidePushBinding: unbound and no copy anywhere → bind (new enrollment)', () => {
  assert.equal(decidePushBinding({ binding: undefined, docType: 'Actor', docId: 'a1', copyExists: false }), 'bind');
});

test('decidePushBinding: unbound but a copy exists → refuse (forged or foreign id)', () => {
  assert.equal(decidePushBinding({ binding: null, docType: 'Actor', docId: 'a1', copyExists: true }), 'refuse');
});

test('decidePushBinding: bound to another doc or another type → refuse', () => {
  assert.equal(decidePushBinding({ binding: { type: 'Actor', id: 'a2' }, docType: 'Actor', docId: 'a1', copyExists: true }), 'refuse');
  assert.equal(decidePushBinding({ binding: { type: 'JournalEntry', id: 'a1' }, docType: 'Actor', docId: 'a1', copyExists: true }), 'refuse');
  assert.equal(decidePushBinding({ binding: { type: 'Actor', id: 'a2' }, docType: 'Actor', docId: 'a1', copyExists: false }), 'refuse');
});

test('decidePushBinding: unbound, no copy, but another local carrier → refuse (first-push race)', () => {
  assert.equal(decidePushBinding({ binding: null, docType: 'Actor', docId: 'a1', copyExists: false, otherCarrier: true }), 'refuse');
  assert.equal(decidePushBinding({ binding: null, docType: 'Actor', docId: 'a1', copyExists: false, otherCarrier: false }), 'bind');
});

test('decidePushBinding: a binding wins over otherCarrier', () => {
  assert.equal(decidePushBinding({ binding: { type: 'Actor', id: 'a1' }, docType: 'Actor', docId: 'a1', copyExists: true, otherCarrier: true }), 'proceed');
});

test('buildBindings: unique ids bound, duplicates left unbound and reported', () => {
  const { bindings, duplicates } = buildBindings([
    { omniId: 'U', type: 'Actor', id: 'a1' },
    { omniId: 'D', type: 'JournalEntry', id: 'j1' },
    { omniId: 'D', type: 'Actor', id: 'a2' },
    { omniId: 'F', type: 'Folder', id: 'f1' },
    { omniId: null, type: 'Actor', id: 'x' }
  ]);
  assert.deepEqual(bindings, { U: { type: 'Actor', id: 'a1' }, F: { type: 'Folder', id: 'f1' } });
  assert.deepEqual(duplicates, { D: [{ type: 'JournalEntry', id: 'j1' }, { type: 'Actor', id: 'a2' }] });
});

test('resolveDuplicateBindings: one enrolled carrier left → bound; none left → dropped; several → kept', () => {
  const duplicates = {
    ONE: [{ type: 'Actor', id: 'a1' }, { type: 'Actor', id: 'a2' }],
    GONE: [{ type: 'Actor', id: 'g1' }, { type: 'Actor', id: 'g2' }],
    STILL: [{ type: 'Actor', id: 's1' }, { type: 'Actor', id: 's2' }]
  };
  const carriers = [
    { omniId: 'ONE', type: 'Actor', id: 'a1', enrolled: true },
    { omniId: 'ONE', type: 'Actor', id: 'a2', enrolled: false },
    { omniId: 'STILL', type: 'Actor', id: 's1', enrolled: true },
    { omniId: 'STILL', type: 'Actor', id: 's2', enrolled: true },
    { omniId: 'OTHER', type: 'Actor', id: 'o1', enrolled: true }
  ];
  assert.deepEqual(resolveDuplicateBindings(duplicates, carriers), {
    bind: { ONE: { type: 'Actor', id: 'a1' } },
    remaining: { STILL: [{ type: 'Actor', id: 's1' }, { type: 'Actor', id: 's2' }] }
  });
});

test('resolveDuplicateBindings: all carriers unenrolled → kept, not bound', () => {
  const out = resolveDuplicateBindings(
    { D: [{ type: 'Actor', id: 'a1' }, { type: 'Actor', id: 'a2' }] },
    [{ omniId: 'D', type: 'Actor', id: 'a1', enrolled: false }]
  );
  assert.deepEqual(out, { bind: {}, remaining: { D: [{ type: 'Actor', id: 'a1' }] } });
});

test('boundOmniToLocal: only bound documents map; forged carriers never do', () => {
  const map = boundOmniToLocal(
    [
      { omniId: 'V', type: 'Actor', id: 'victim' },
      { omniId: 'V', type: 'Actor', id: 'forger' },
      { omniId: 'N', type: 'JournalEntry', id: 'unbound' }
    ],
    { V: { type: 'Actor', id: 'victim' } }
  );
  assert.deepEqual([...map], [['V', 'victim']]);
});

test('validateFolderRemoval: owner of the copy or the root may remove; strangers may not', () => {
  const base = { copyExists: true, copyInTree: true, bound: true, copyOwnerName: 'User 1', rootOwnerName: 'User 2', actingIsGM: false };
  assert.equal(validateFolderRemoval({ ...base, actingUserName: 'User 1' }), true);
  assert.equal(validateFolderRemoval({ ...base, actingUserName: 'User 2' }), true);
  assert.equal(validateFolderRemoval({ ...base, actingUserName: 'User 3' }), false);
  assert.equal(validateFolderRemoval({ ...base, actingUserName: null }), false);
});

test('validateFolderRemoval: a GM is exempt from the ownerName rule but not from tree and binding', () => {
  const base = { copyExists: true, copyInTree: true, bound: true, copyOwnerName: null, rootOwnerName: null, actingUserName: 'Gamemaster', actingIsGM: true };
  assert.equal(validateFolderRemoval(base), true);
  assert.equal(validateFolderRemoval({ ...base, bound: false }), false);
  assert.equal(validateFolderRemoval({ ...base, copyInTree: false }), false);
});

test('validateFolderRemoval: a missing copy is a silent no-op success, but never for an unbound journal', () => {
  const gone = { copyExists: false, copyInTree: false, copyOwnerName: null, rootOwnerName: 'User 2', actingUserName: 'User 3', actingIsGM: false };
  assert.equal(validateFolderRemoval({ ...gone, bound: true }), true);
  assert.equal(validateFolderRemoval({ ...gone, bound: false }), false);
});
