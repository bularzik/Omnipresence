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
  const count = await gmPage.evaluate(async (id) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    await SyncRegistry.addToSelection(game.user.id, 'actor', id);
    await Promise.all([SyncEngine.importMissing(), SyncEngine.importMissing()]);
    return game.actors.filter(a => a.getFlag('omnipresence', 'id') === id).length;
  }, id);
  expect(count).toBe(1);
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
