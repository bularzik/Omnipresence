// tests/e2e/live-import.spec.js — op-87b: documents a user picks import right
// away (player-side with "Create New Actors", else by the connected GM), never
// as a duplicate, and merged-away pack stubs are never imported or listed.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

const PREFIX = 'Omni Live';
let browser, gmContext, gmPage, playerName;

/** GM page: create a pack actor carrying omnipresence flags; returns its id. */
async function seedPack(page, { name, ownerName = null, extraFlags = {} }) {
  return page.evaluate(async ({ name, ownerName, extraFlags }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const id = foundry.utils.randomID(16);
    await Actor.create({
      name, type: 'character',
      flags: { omnipresence: { id, ownerName, syncedAt: new Date().toISOString(), ...extraFlags } }
    }, { pack: SyncEngine.PACK_ID, omnipresenceInternal: true });
    return id;
  }, { name, ownerName, extraFlags });
}

async function cleanup(page) {
  await page?.evaluate(async (PREFIX) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    // Case/space-insensitive: the duplicate-guard test creates " omni live … ".
    const ours = name => name.trim().toLowerCase().startsWith(PREFIX.toLowerCase());
    for (const a of game.actors.filter(a => ours(a.name))) await a.delete({ omnipresenceInternal: true });
    const pack = game.packs.get(SyncEngine.PACK_ID);
    for (const d of await pack.getDocuments()) if (ours(d.name)) await d.delete({ omnipresenceInternal: true });
  }, PREFIX).catch(() => {});
}

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  playerName = await gmPage.evaluate(() => game.users.find(u => !u.isGM)?.name ?? null);
  if (!playerName) throw new Error('Prerequisite missing: a non-GM user must exist in the world.');
  await cleanup(gmPage);
});

test.afterAll(async () => {
  await cleanup(gmPage);
  await gmContext?.close();
  await browser?.close();
});

test('duplicate guard: unsynced same-name local actor blocks import and notifies', async () => {
  const name = `${PREFIX} Thorin`;
  const id = await seedPack(gmPage, { name, ownerName: playerName });
  const out = await gmPage.evaluate(async ({ name, id, playerName }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const player = game.users.getName(playerName);
    await Actor.create({ name: ` ${name.toLowerCase()} `, type: 'character', ownership: { default: 0, [player.id]: 3 } });
    await SyncRegistry.addToSelection(player.id, 'actor', id);
    const seen = [];
    const orig = ui.notifications.warn.bind(ui.notifications);
    ui.notifications.warn = (msg, ...rest) => { seen.push(String(msg)); return orig(msg, ...rest); };
    try { await SyncEngine.importMissing(); } finally { ui.notifications.warn = orig; }
    return {
      count: game.actors.filter(a => a.name.trim().toLowerCase() === name.toLowerCase()).length,
      imported: game.actors.some(a => a.getFlag('omnipresence', 'id') === id),
      seen
    };
  }, { name, id, playerName });
  expect(out.count).toBe(1);
  expect(out.imported).toBe(false);
  expect(out.seen.some(m => m.includes("isn't synced"))).toBe(true);
});

test('concurrent importMissing creates one copy', async () => {
  const id = await seedPack(gmPage, { name: `${PREFIX} Concurrent` });
  // The selection change itself starts a live import (updateUser hook), so
  // three runs overlap here; a run that finds the id in flight returns early.
  await gmPage.evaluate(async (id) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    await SyncRegistry.addToSelection(game.user.id, 'actor', id);
    await Promise.all([SyncEngine.importMissing(), SyncEngine.importMissing()]);
  }, id);
  const count = () => gmPage.evaluate(id => game.actors.filter(a => a.getFlag('omnipresence', 'id') === id).length, id);
  await expect.poll(count, { timeout: 5_000 }).toBe(1);
  await gmPage.waitForTimeout(1_500);
  expect(await count()).toBe(1);
});

test('mergedInto stub is never imported or listed', async () => {
  const id = await seedPack(gmPage, { name: `${PREFIX} Stub`, extraFlags: { mergedInto: 'X'.repeat(16) } });
  const out = await gmPage.evaluate(async (id) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { DocPicker } = await import('/modules/omnipresence/scripts/doc-picker.js');
    await SyncRegistry.addToSelection(game.user.id, 'actor', id);
    await SyncEngine.importMissing();
    const listed = (await DocPicker._candidatesFor(SyncEngine.PACK_ID, game.actors)).some(c => c.id === id);
    return { imported: game.actors.some(a => a.getFlag('omnipresence', 'id') === id), listed };
  }, id);
  expect(out.imported).toBe(false);
  expect(out.listed).toBe(false);
});

// --- Task 4: live reaction while both GM and player are connected ----------

test.describe('live import with a connected player', () => {
  let playerContext, playerPage;

  /** GM page: grant or revoke "Create New Actors" for the PLAYER role. */
  async function setPlayerCanCreate(on) {
    await gmPage.evaluate(async (on) => {
      const perms = foundry.utils.deepClone(game.settings.get('core', 'permissions'));
      const roles = new Set(perms.ACTOR_CREATE ?? []);
      for (const r of [1, 2]) on ? roles.add(r) : roles.delete(r);
      perms.ACTOR_CREATE = [...roles].sort();
      await game.settings.set('core', 'permissions', perms);
    }, on);
  }

  test.beforeAll(async () => {
    playerContext = await browser.newContext();
    playerPage = await playerContext.newPage();
    await loginToFoundry(playerPage, playerName);
  });

  test.afterAll(async () => {
    await setPlayerCanCreate(false).catch(() => {});
    await playerContext?.close();
  });

  const findById = (page, id) => page.evaluate(id =>
    game.actors.filter(a => a.getFlag('omnipresence', 'id') === id).map(a => ({
      ownedByPlayer: a.testUserPermission(game.users.find(u => !u.isGM), 'OWNER')
    })), id);

  test('player with Create Actors: picked actor appears with no reload', async () => {
    await setPlayerCanCreate(true);
    const id = await seedPack(gmPage, { name: `${PREFIX} Self`, ownerName: playerName });
    await playerPage.evaluate(async (id) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const { runLoginReconcile } = await import('/modules/omnipresence/scripts/reconcile.js');
      await SyncRegistry.addToSelection(game.user.id, 'actor', id);
      await runLoginReconcile();
    }, id);
    await expect.poll(() => findById(gmPage, id), { timeout: 5_000 }).toHaveLength(1);
    const onPlayer = await findById(playerPage, id);
    expect(onPlayer).toHaveLength(1);
    expect(onPlayer[0].ownedByPlayer).toBe(true);
  });

  test('player without permission + GM connected: GM imports exactly one copy', async () => {
    await setPlayerCanCreate(false);
    const id = await seedPack(gmPage, { name: `${PREFIX} ViaGM`, ownerName: playerName });
    await playerPage.evaluate(async (id) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      await SyncRegistry.addToSelection(game.user.id, 'actor', id);
    }, id);
    await expect.poll(() => findById(gmPage, id), { timeout: 5_000 }).toHaveLength(1);
    await gmPage.waitForTimeout(1_500);
    const after = await findById(gmPage, id);
    expect(after).toHaveLength(1);
    expect(after[0].ownedByPlayer).toBe(true);
  });

  test('unchecking a document never deletes it', async () => {
    const id = await seedPack(gmPage, { name: `${PREFIX} Uncheck`, ownerName: playerName });
    await playerPage.evaluate(async (id) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      await SyncRegistry.addToSelection(game.user.id, 'actor', id);
    }, id);
    await expect.poll(() => findById(gmPage, id), { timeout: 5_000 }).toHaveLength(1);
    await playerPage.evaluate(async (id) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      await SyncRegistry.removeFromSelection(game.user.id, 'actor', id);
    }, id);
    await gmPage.waitForTimeout(2_000);
    const still = await gmPage.evaluate(async (id) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const a = game.actors.find(a => a.getFlag('omnipresence', 'id') === id);
      return { exists: !!a, enrolled: a ? SyncRegistry.isEnrolled(a) : false };
    }, id);
    expect(still).toEqual({ exists: true, enrolled: true });
  });
});
