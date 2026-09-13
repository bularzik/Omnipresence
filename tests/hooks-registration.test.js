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

test('registers folder sync hooks (v13 names) via omnipresence.js', async () => {
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

  await import('../omnipresence.js?folder-hooks');

  const names = onCalls.map((c) => c.name);
  for (const h of ['getFolderContextOptions', 'createFolder', 'updateFolder', 'preDeleteFolder', 'deleteFolder', 'createJournalEntry']) {
    assert.ok(names.includes(h), `expected hook '${h}', got: ${names.join(', ')}`);
  }
});

// v14 renamed ContextMenuEntry fields (name→label, condition→visible,
// callback→onClick) and deprecates the old names (removed in v16); v13 reads
// only the old names. Every entry the module pushes must carry both shapes so
// one build renders warning-free on either version, and the v14 onClick
// (event, target) must reach the same callback as the v13 callback(target).
test('directory context-menu entries carry both v13 and v14 field names', async () => {
  const { menuEntry, registerContextMenu, registerJournalContextMenu, registerFolderContextMenu } =
    await import('../scripts/context-menu.js');

  for (const [label, register] of [
    ['actor', registerContextMenu],
    ['journal', registerJournalContextMenu],
    ['folder', registerFolderContextMenu]
  ]) {
    const entryOptions = [];
    register(entryOptions);
    assert.ok(entryOptions.length >= 2, `${label} menu should push add/remove entries`);
    for (const entry of entryOptions) {
      assert.equal(typeof entry.name, 'string', `${label}: v13 name`);
      assert.equal(entry.label, entry.name, `${label}: v14 label mirrors name`);
      assert.equal(typeof entry.condition, 'function', `${label}: v13 condition`);
      assert.equal(entry.visible, entry.condition, `${label}: v14 visible mirrors condition`);
      assert.equal(typeof entry.callback, 'function', `${label}: v13 callback`);
      assert.equal(typeof entry.onClick, 'function', `${label}: v14 onClick`);
    }
  }

  // v14 calls onClick(event, target); v13 calls callback(target). Same handler.
  const seen = [];
  const entry = menuEntry({
    name: 'X', icon: '', condition: () => true, callback: (target) => seen.push(target)
  });
  const target = { id: 'li' };
  entry.onClick({ type: 'click' }, target);
  entry.callback(target);
  assert.deepEqual(seen, [target, target]);
});
