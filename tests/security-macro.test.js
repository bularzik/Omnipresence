import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  macroPushDecision, decideScriptMacroInstall, macroCopiesToDelete, sha256Hex
} from '../scripts/security-logic.js';

// --- Macro rules ------------------------------------------------------------

test('macroPushDecision: missing macro → dangling; not owned by the hotbar user → skip; owned → push', () => {
  assert.equal(macroPushDecision({ exists: false, ownedByUser: false }), 'dangling');
  assert.equal(macroPushDecision({ exists: true, ownedByUser: false }), 'skip');
  assert.equal(macroPushDecision({ exists: true, ownedByUser: true }), 'push');
});

test('decideScriptMacroInstall: players and chat macros always install', () => {
  assert.equal(decideScriptMacroInstall({ isGM: false, type: 'script', localCommand: null, packCommand: 'x', packHash: 'h', approvedHashes: [] }), 'install');
  assert.equal(decideScriptMacroInstall({ isGM: true, type: 'chat', localCommand: null, packCommand: 'x', packHash: 'h', approvedHashes: [] }), 'install');
});

test('decideScriptMacroInstall: GM script macro new locally or changed → confirm', () => {
  assert.equal(decideScriptMacroInstall({ isGM: true, type: 'script', localCommand: null, packCommand: 'x', packHash: 'h', approvedHashes: [] }), 'confirm');
  assert.equal(decideScriptMacroInstall({ isGM: true, type: 'script', localCommand: 'old', packCommand: 'x', packHash: 'h', approvedHashes: [] }), 'confirm');
});

test('decideScriptMacroInstall: unchanged command or previously approved hash → install', () => {
  assert.equal(decideScriptMacroInstall({ isGM: true, type: 'script', localCommand: 'x', packCommand: 'x', packHash: 'h', approvedHashes: [] }), 'install');
  assert.equal(decideScriptMacroInstall({ isGM: true, type: 'script', localCommand: null, packCommand: 'x', packHash: 'h', approvedHashes: ['h'] }), 'install');
});

test("macroCopiesToDelete: only this user's copies from this world, not pushed, not held by a dangling slot", () => {
  const copies = [
    { omniId: 'keep-pushed', ownerName: 'U', originWorld: 'w', slots: [1] },
    { omniId: 'delete-me', ownerName: 'U', originWorld: 'w', slots: [2] },
    { omniId: 'other-world', ownerName: 'U', originWorld: 'x', slots: [3] },
    { omniId: 'untagged', ownerName: 'U', originWorld: undefined, slots: [4] },
    { omniId: 'dangling', ownerName: 'U', originWorld: 'w', slots: [5] },
    { omniId: 'same-name-elsewhere', ownerName: 'V', originWorld: 'w', slots: [6] }
  ];
  assert.deepEqual(
    macroCopiesToDelete(copies, { userName: 'U', worldId: 'w', pushedIds: ['keep-pushed'], danglingSlots: [5] }),
    ['delete-me']
  );
});

test('sha256Hex: FIPS 180-4 test vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('sha256Hex: multi-block and non-ASCII input are hashed as UTF-8', () => {
  assert.equal(sha256Hex('a'.repeat(1000)), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  // NFC é (U+00E9) and NFD e + combining acute (U+0065 U+0301) are different UTF-8 bytes.
  assert.equal(sha256Hex('é'), '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  assert.equal(sha256Hex('é'), 'bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6');
});
