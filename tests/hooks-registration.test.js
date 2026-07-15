import { test } from 'node:test';
import assert from 'node:assert/strict';

// omnipresence.js wires Foundry hooks at import time. Capture the registrations
// with a mock global Hooks so we can assert the actor-directory context menu is
// bound to the hook name Foundry v13 actually fires.
//
// v13 migrated the sidebar to ApplicationV2 and renamed directory context-menu
// hooks to the get{DocumentName}ContextOptions pattern. The v12 name
// getActorDirectoryEntryContext no longer fires, so binding to it leaves the
// Add/Remove menu items invisible for every user (GM and player alike).
test('registers actor context menu on the v13 getActorContextOptions hook', async () => {
  const onCalls = [];
  globalThis.Hooks = {
    on: (name, fn) => onCalls.push({ name, fn }),
    once: () => {}
  };
  // gm-dashboard.js extends foundry.applications.api at import time.
  globalThis.foundry = {
    applications: {
      api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base }
    }
  };

  await import('../omnipresence.js');

  const names = onCalls.map((c) => c.name);
  assert.ok(
    names.includes('getActorContextOptions'),
    `expected a handler on 'getActorContextOptions' (v13), got: ${names.join(', ')}`
  );
  assert.ok(
    !names.includes('getActorDirectoryEntryContext'),
    "must not bind the removed v12 hook 'getActorDirectoryEntryContext'"
  );
});

test('registers journal sync hooks (v13 names) via omnipresence.js', async () => {
  const onCalls = [];
  globalThis.Hooks = {
    on: (name, fn) => onCalls.push({ name, fn }),
    once: () => {}
  };
  globalThis.foundry = {
    applications: {
      api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base }
    }
  };

  // Cache-busting query so omnipresence.js top-level re-runs against this mock.
  await import('../omnipresence.js?journal-hooks');

  const names = onCalls.map((c) => c.name);
  assert.ok(
    names.includes('getJournalEntryContextOptions'),
    `expected 'getJournalEntryContextOptions', got: ${names.join(', ')}`
  );
  for (const h of ['updateJournalEntry', 'createJournalEntryPage', 'updateJournalEntryPage', 'deleteJournalEntryPage', 'deleteJournalEntry']) {
    assert.ok(names.includes(h), `expected hook '${h}', got: ${names.join(', ')}`);
  }
});
