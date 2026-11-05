import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HIDDEN_PACK_OWNERSHIP } from '../scripts/security-logic.js';

// Pack ownership is read from module.json at server start: the manifest is
// what hides the packs from players in the UI (#3).
const manifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url), 'utf8'));

test('module.json: all 8 Omnipresence packs are hidden from players', () => {
  assert.equal(manifest.packs.length, 8);
  for (const p of manifest.packs) assert.deepEqual(p.ownership, { ...HIDDEN_PACK_OWNERSHIP }, p.name);
});
