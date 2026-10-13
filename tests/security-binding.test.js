import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePushBinding, buildBindings, resolveDuplicateBindings, boundOmniToLocal, validateFolderRemoval,
  judgePendingRemoveClaim, pullAllowed, mergeDuplicateRecord, pushRefusalRecord
} from '../scripts/security-logic.js';

// --- Login pull rule (cross-world first-push race) --------------------------

test('pullAllowed: once bindings are built, only the bound document may pull', () => {
  const base = { bindingsBuilt: true, docType: 'Actor', docId: 'a1' };
  assert.equal(pullAllowed({ ...base, binding: { type: 'Actor', id: 'a1' } }), true);
  assert.equal(pullAllowed({ ...base, binding: null }), false);
  assert.equal(pullAllowed({ ...base, binding: undefined }), false);
  assert.equal(pullAllowed({ ...base, binding: { type: 'Actor', id: 'a2' } }), false);
  assert.equal(pullAllowed({ ...base, binding: { type: 'JournalEntry', id: 'a1' } }), false);
});

test('pullAllowed: before bindings are built, only a binding to another document refuses', () => {
  const base = { bindingsBuilt: false, docType: 'Actor', docId: 'a1' };
  assert.equal(pullAllowed({ ...base, binding: null }), true);
  assert.equal(pullAllowed({ ...base, binding: { type: 'Actor', id: 'a1' } }), true);
  assert.equal(pullAllowed({ ...base, binding: { type: 'Actor', id: 'a2' } }), false);
});

test('resolveDuplicateBindings: an unbound-but-copy-exists record is never auto-bound and survives while its carrier lives', () => {
  const recorded = { x: [{ type: 'Actor', id: 'a1' }, { type: 'SharedCopy', id: 'x' }] };
  const live = [{ omniId: 'x', type: 'Actor', id: 'a1', enrolled: true }];
  const { bind, remaining } = resolveDuplicateBindings(recorded, live);
  assert.deepEqual(bind, {});
  assert.deepEqual(remaining.x, [{ type: 'Actor', id: 'a1' }, { type: 'SharedCopy', id: 'x' }]);
  assert.deepEqual(resolveDuplicateBindings(recorded, []).remaining, {});
});

test('mergeDuplicateRecord: a later refusal of the same id keeps the SharedCopy marker, so the survivor is never auto-bound', () => {
  const first = mergeDuplicateRecord(undefined, [{ type: 'Actor', id: 'a1' }, { type: 'SharedCopy', id: 'x' }]);
  // A push refusal (authorizePush) for a second carrier of x, without a marker.
  const second = mergeDuplicateRecord(first, [{ type: 'Actor', id: 'a2' }, { type: 'Actor', id: 'a1' }]);
  assert.deepEqual(second, [{ type: 'Actor', id: 'a1' }, { type: 'Actor', id: 'a2' }, { type: 'SharedCopy', id: 'x' }]);
  // The GM removes a2 from sync: a1 is the only enrolled carrier left, still not bound.
  const { bind, remaining } = resolveDuplicateBindings({ x: second }, [
    { omniId: 'x', type: 'Actor', id: 'a1', enrolled: true },
    { omniId: 'x', type: 'Actor', id: 'a2', enrolled: false }
  ]);
  assert.deepEqual(bind, {});
  assert.deepEqual(remaining.x, [{ type: 'Actor', id: 'a1' }, { type: 'SharedCopy', id: 'x' }]);
});

test('pushRefusalRecord: unbound with a shared copy → marked, even with no other carrier; the survivor is never auto-bound', () => {
  const doc = { type: 'Actor', id: 'b1' };
  const others = [{ omniId: 'x', type: 'Actor', id: 'b2', enrolled: true }];
  const record = pushRefusalRecord({ omniId: 'x', bound: false, copyExists: true, doc, others });
  assert.deepEqual(record, [{ type: 'Actor', id: 'b1' }, { type: 'Actor', id: 'b2' }, { type: 'SharedCopy', id: 'x' }]);
  assert.deepEqual(
    pushRefusalRecord({ omniId: 'x', bound: false, copyExists: true, doc, others: [] }),
    [{ type: 'Actor', id: 'b1' }, { type: 'SharedCopy', id: 'x' }]
  );
  // b2 is removed from sync: b1 is the one enrolled carrier left, and stays unbound.
  const { bind, remaining } = resolveDuplicateBindings({ x: record }, [
    { omniId: 'x', type: 'Actor', id: 'b1', enrolled: true },
    { omniId: 'x', type: 'Actor', id: 'b2', enrolled: false }
  ]);
  assert.deepEqual(bind, {});
  assert.deepEqual(remaining.x, [{ type: 'Actor', id: 'b1' }, { type: 'SharedCopy', id: 'x' }]);
});

test('pushRefusalRecord: bound → nothing; unbound, no copy → plain duplicate only with other carriers', () => {
  const doc = { type: 'Actor', id: 'a1' };
  const others = [{ type: 'Actor', id: 'a2' }];
  assert.equal(pushRefusalRecord({ omniId: 'x', bound: true, copyExists: true, doc, others }), null);
  assert.deepEqual(
    pushRefusalRecord({ omniId: 'x', bound: false, copyExists: false, doc, others }),
    [{ type: 'Actor', id: 'a1' }, { type: 'Actor', id: 'a2' }]
  );
  assert.equal(pushRefusalRecord({ omniId: 'x', bound: false, copyExists: false, doc, others: [] }), null);
});

test('resolveDuplicateBindings: a SharedCopy record whose last carrier was removed from sync is dropped, not bound', () => {
  const recorded = { x: [{ type: 'Actor', id: 'a1' }, { type: 'SharedCopy', id: 'x' }] };
  assert.deepEqual(
    resolveDuplicateBindings(recorded, [{ omniId: 'x', type: 'Actor', id: 'a1', enrolled: false }]),
    { bind: {}, remaining: {} }
  );
});

test('resolveDuplicateBindings: a carrier removed from sync is no longer listed while others stay enrolled', () => {
  const out = resolveDuplicateBindings(
    { D: [{ type: 'Actor', id: 'a1' }, { type: 'Actor', id: 'a2' }, { type: 'Actor', id: 'a3' }] },
    [
      { omniId: 'D', type: 'Actor', id: 'a1', enrolled: true },
      { omniId: 'D', type: 'Actor', id: 'a2', enrolled: false },
      { omniId: 'D', type: 'Actor', id: 'a3', enrolled: true }
    ]
  );
  assert.deepEqual(out, { bind: {}, remaining: { D: [{ type: 'Actor', id: 'a1' }, { type: 'Actor', id: 'a3' }] } });
});

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

test('judgePendingRemoveClaim: a flag claiming a GM, an unknown user, a non-owner or a legacy string is refused', () => {
  const flag = { rootId: 'r', userId: 'u' };
  assert.equal(judgePendingRemoveClaim({ flag, user: { isGM: true }, isOwner: true }), 'refuse');
  assert.equal(judgePendingRemoveClaim({ flag, user: null, isOwner: true }), 'refuse');
  assert.equal(judgePendingRemoveClaim({ flag, user: { isGM: false }, isOwner: false }), 'refuse');
  assert.equal(judgePendingRemoveClaim({ flag: 'r', user: { isGM: false }, isOwner: true }), 'refuse');
  assert.equal(judgePendingRemoveClaim({ flag, user: { isGM: false }, isOwner: true }), 'accept');
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
