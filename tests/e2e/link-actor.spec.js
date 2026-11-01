// tests/e2e/link-actor.spec.js — op-87b: "Link to synced character…" connects
// a local actor (e.g. a D&D Beyond re-import) to its shared compendium
// character, with the user choosing which copy wins, and merges an
// already-synced duplicate into the original shared character.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

const PREFIX = 'Omni Link';
let browser, gmContext, gmPage, playerName;

/** GM page: create a pack actor with a biography; returns its omnipresence id. */
async function seedPack(page, { name, bio, ownerName = null, extraFlags = {} }) {
  return page.evaluate(async ({ name, bio, ownerName, extraFlags }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const id = foundry.utils.randomID(16);
    await Actor.create({
      name, type: 'character',
      system: { details: { biography: { value: bio } } },
      flags: { omnipresence: { id, ownerName, syncedAt: new Date(Date.now() - 60_000).toISOString(), ...extraFlags } }
    }, { pack: SyncEngine.PACK_ID, omnipresenceInternal: true });
    return id;
  }, { name, bio, ownerName, extraFlags });
}

/** Page: create an unenrolled local actor; returns its local id. */
async function seedLocal(page, { name, bio, flags = {}, ownership }) {
  return page.evaluate(async ({ name, bio, flags, ownership }) => {
    const a = await Actor.create({
      name, type: 'character', flags, ...(ownership ? { ownership } : {}),
      system: { details: { biography: { value: bio } } }
    });
    return a.id;
  }, { name, bio, flags, ownership });
}

async function cleanup(page) {
  await page?.evaluate(async (PREFIX) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const ours = name => name.trim().toLowerCase().startsWith(PREFIX.toLowerCase());
    for (const a of game.actors.filter(a => ours(a.name))) await a.delete({ omnipresenceInternal: true });
    const pack = game.packs.get(SyncEngine.PACK_ID);
    for (const d of await pack.getDocuments()) if (ours(d.name)) await d.delete({ omnipresenceInternal: true });
  }, PREFIX).catch(() => {});
}

/** Page: run linkActor(localId, packOmniId, winner). */
async function link(page, localId, omniId, winner) {
  return page.evaluate(async ({ localId, omniId, winner }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { linkActor } = await import('/modules/omnipresence/scripts/link-actor.js');
    const comp = (await game.packs.get(SyncEngine.PACK_ID).getDocuments())
      .find(d => d.getFlag('omnipresence', 'id') === omniId);
    await linkActor(game.actors.get(localId), comp, winner);
  }, { localId, omniId, winner });
}

/** Page: the pack copy's biography (fresh read). */
const packBio = (page, omniId) => page.evaluate(async (omniId) => {
  const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
  const pack = game.packs.get(SyncEngine.PACK_ID);
  pack.clear?.();
  const d = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
  return d?.system?.details?.biography?.value ?? null;
}, omniId);

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

test('link "shared": local actor takes compendium data and keeps foreign flags', async () => {
  const omniId = await seedPack(gmPage, { name: `${PREFIX} Shared`, bio: 'SHARED' });
  const localId = await seedLocal(gmPage, { name: `${PREFIX} Shared`, bio: 'LOCAL', flags: { ddbimporter: { probe: 1 } } });
  await link(gmPage, localId, omniId, 'shared');
  const out = await gmPage.evaluate(async (localId) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const a = game.actors.get(localId);
    return {
      bio: a.system.details.biography.value,
      probe: a.flags.ddbimporter?.probe, // getFlag throws: module not installed here
      id: a.getFlag('omnipresence', 'id'),
      enrolled: SyncRegistry.isEnrolled(a)
    };
  }, localId);
  expect(out).toEqual({ bio: 'SHARED', probe: 1, id: omniId, enrolled: true });
});

test('link "local" as GM: compendium updated from local', async () => {
  const omniId = await seedPack(gmPage, { name: `${PREFIX} Local`, bio: 'SHARED' });
  const localId = await seedLocal(gmPage, { name: `${PREFIX} Local`, bio: 'LOCAL' });
  await link(gmPage, localId, omniId, 'local');
  await expect.poll(() => packBio(gmPage, omniId), { timeout: 5_000 }).toBe('LOCAL');
});

test('link removes a stale auto-imported copy', async () => {
  const omniId = await seedPack(gmPage, { name: `${PREFIX} Stale`, bio: 'SHARED' });
  await gmPage.evaluate(async (omniId) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    await SyncRegistry.addToSelection(game.user.id, 'actor', omniId);
    await SyncEngine.importMissing();
  }, omniId);
  const localId = await seedLocal(gmPage, { name: `${PREFIX} Stale (ddb)`, bio: 'LOCAL' });
  await link(gmPage, localId, omniId, 'shared');
  const ids = await gmPage.evaluate(omniId =>
    game.actors.filter(a => a.getFlag('omnipresence', 'id') === omniId).map(a => a.id), omniId);
  expect(ids).toEqual([localId]);
});

// --- Task 6: a player's "keep this" reaches the compendium ------------------

test.describe('player links with "Keep this"', () => {
  let playerContext, playerPage;

  test.beforeAll(async () => {
    playerContext = await browser.newContext();
    playerPage = await playerContext.newPage();
    await loginToFoundry(playerPage, playerName);
  });
  test.afterAll(async () => { await playerContext?.close(); });

  /** GM page: a player-owned pack copy plus a player-owned unenrolled local actor. */
  async function seedPlayerPair(name) {
    const omniId = await seedPack(gmPage, { name, bio: 'SHARED', ownerName: playerName });
    const playerId = await gmPage.evaluate(n => game.users.getName(n).id, playerName);
    const localId = await seedLocal(gmPage, { name, bio: 'LOCAL', ownership: { default: 0, [playerId]: 3 } });
    await playerPage.waitForFunction(id => !!game.actors.get(id), localId, { timeout: 10_000 });
    return { omniId, localId };
  }

  test('player link "local" with GM connected: compendium updated within 5s', async () => {
    const { omniId, localId } = await seedPlayerPair(`${PREFIX} PlayerKeep`);
    await link(playerPage, localId, omniId, 'local');
    await expect.poll(() => packBio(gmPage, omniId), { timeout: 8_000 }).toBe('LOCAL');
  });

  test('player link "local" with no GM: next GM login pushes, no conflict', async () => {
    const { omniId, localId } = await seedPlayerPair(`${PREFIX} PlayerOffline`);
    await gmContext.close();
    // Sync point: the player must see no GM connected before linking.
    await playerPage.waitForFunction(() => !game.users.activeGM, null, { timeout: 15_000 });
    await link(playerPage, localId, omniId, 'local');
    gmContext = await browser.newContext();
    gmPage = await gmContext.newPage();
    await loginToFoundry(gmPage, 'Gamemaster');
    try {
      await expect.poll(() => packBio(gmPage, omniId), { timeout: 30_000 }).toBe('LOCAL'); // v14 login reconcile is slow
    } catch (e) {
      console.log('DIAG', JSON.stringify(await gmPage.evaluate(async ({ omniId, localId }) => {
        const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
        const pack = game.packs.get(SyncEngine.PACK_ID); pack.clear?.();
        const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
        return { local: game.actors.get(localId)?.flags.omnipresence, comp: comp?.flags.omnipresence,
          dash: [...document.querySelectorAll('#omnipresence-dashboard')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 300)) };
      }, { omniId, localId })));
      throw e;
    }
    const dashboard = await gmPage.evaluate(() =>
      [...document.querySelectorAll('#omnipresence-dashboard')].map(e => e.innerText).join(' '));
    expect(dashboard).not.toContain(`${PREFIX} PlayerOffline`);
  });
});
