import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN_PACK_OWNERSHIP, ownershipExposesPlayers } from '../scripts/security-logic.js';

// --- Hidden packs -----------------------------------------------------------

test('HIDDEN_PACK_OWNERSHIP is the declared value', () => {
  assert.deepEqual({ ...HIDDEN_PACK_OWNERSHIP }, { PLAYER: 'NONE', TRUSTED: 'NONE', ASSISTANT: 'OWNER' });
});

test('ownershipExposesPlayers: Foundry module-pack default (PLAYER OBSERVER) exposes', () => {
  assert.equal(ownershipExposesPlayers({ PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' }), true);
});

test('ownershipExposesPlayers: a world override giving TRUSTED LIMITED exposes', () => {
  assert.equal(ownershipExposesPlayers({ PLAYER: 'NONE', TRUSTED: 'LIMITED', ASSISTANT: 'OWNER' }), true);
});

test('ownershipExposesPlayers: hidden ownership, INHERIT, and missing roles do not expose', () => {
  assert.equal(ownershipExposesPlayers(HIDDEN_PACK_OWNERSHIP), false);
  assert.equal(ownershipExposesPlayers({ PLAYER: 'NONE', TRUSTED: 'INHERIT', ASSISTANT: 'OWNER' }), false);
  assert.equal(ownershipExposesPlayers({ ASSISTANT: 'OWNER' }), false);
  assert.equal(ownershipExposesPlayers(undefined), false);
});
