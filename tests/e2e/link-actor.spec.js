// tests/e2e/link-actor.spec.js — op-87b: "Link to synced character…" connects
// a local actor (e.g. a D&D Beyond re-import) to its shared compendium
// character, with the user choosing which copy wins, and merges an
// already-synced duplicate into the original shared character.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

const PREFIX = 'Omni Link';
let browser, gmContext, gmPage, playerName;
const gmErrors = [];
const watchGm = page => {
  page.on('console', m => { if (m.type() === 'error' || /Omnipresence/.test(m.text())) gmErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', e => gmErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
};

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
  // No pack.clear(): getDocuments() queries the server, and clearing the
  // cache mid-write makes a concurrent GM push/stub write fail.
  const pack = game.packs.get(SyncEngine.PACK_ID);
  const d = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
  return d?.system?.details?.biography?.value ?? null;
}, omniId);

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  watchGm(gmPage);
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
    const t0 = Date.now();
    try {
      await expect.poll(() => packBio(gmPage, omniId), { timeout: 8_000 }).toBe('LOCAL'); // 2s push debounce
    } catch (e) {
      let late = null;
      for (let i = 0; i < 30 && late === null; i++) {
        await gmPage.waitForTimeout(1_000);
        if (await packBio(gmPage, omniId) === 'LOCAL') late = Date.now() - t0;
      }
      const gmLocal = await gmPage.evaluate(id => ({ bio: game.actors.get(id)?.system.details.biography.value, flags: game.actors.get(id)?.flags.omnipresence }), localId);
      console.log('DIAG2', JSON.stringify({ lateMs: late, gmLocal }));
      throw e;
    }
  });

  test('player link "local" with no GM: next GM login pushes, no conflict', async () => {
    const { omniId, localId } = await seedPlayerPair(`${PREFIX} PlayerOffline`);
    await gmContext.close();
    // Sync point: the player must see no GM connected before linking.
    await playerPage.waitForFunction(() => !game.users.activeGM, null, { timeout: 15_000 });
    await link(playerPage, localId, omniId, 'local');
    gmContext = await browser.newContext();
    gmPage = await gmContext.newPage();
    watchGm(gmPage);
    await loginToFoundry(gmPage, 'Gamemaster');
    try {
      await expect.poll(() => packBio(gmPage, omniId), { timeout: 15_000 }).toBe('LOCAL');
    } catch (e) {
      console.log('DIAG', JSON.stringify(await gmPage.evaluate(async ({ omniId, localId }) => {
        const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
        const pack = game.packs.get(SyncEngine.PACK_ID);
        const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
        const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
        const p = game.users.find(u => !u.isGM);
        const selected = SyncRegistry.isDocSelected(p.id, 'actor', omniId);
        const enabled = SyncRegistry.isActorSyncEnabled(p.id);
        await SyncEngine.onLogin();
        const after = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId)?.system?.details?.biography?.value;
        return { selected, enabled, afterManualOnLogin: after, local: game.actors.get(localId)?.flags.omnipresence, comp: comp?.flags.omnipresence,
          dash: [...document.querySelectorAll('#omnipresence-dashboard')].map(e => e.innerText.replace(/\s+/g, ' ').slice(0, 300)) };
      }, { omniId, localId })), 'GM console:', JSON.stringify(gmErrors.slice(-15)));
      throw e;
    }
    const dashboard = await gmPage.evaluate(() =>
      [...document.querySelectorAll('#omnipresence-dashboard')].map(e => e.innerText).join(' '));
    expect(dashboard).not.toContain(`${PREFIX} PlayerOffline`);
  });
});

// --- Task 7: merge an already-synced duplicate (Y) into the original (X) ----

/** GM page: a local actor already enrolled as `omniId`, owned by the player. */
async function seedEnrolledLocal(page, { name, bio, omniId, ownerName, dirty = false }) {
  return page.evaluate(async ({ name, bio, omniId, ownerName, dirty }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const player = game.users.getName(ownerName);
    const t = new Date(Date.now() - 120_000).toISOString();
    const a = await Actor.create({
      name, type: 'character',
      ownership: { default: 0, [player.id]: 3 },
      system: { details: { biography: { value: bio } } },
      flags: { omnipresence: { id: omniId, ownerName, enrolled: true, syncedAt: t, localModifiedAt: dirty ? new Date().toISOString() : t } }
    }, { omnipresenceInternal: true });
    await SyncRegistry.addToSelection(player.id, 'actor', omniId);
    return a.id;
  }, { name, bio, omniId, ownerName, dirty });
}

/** GM page: { mergedInto of pack Y, local actor's id, player's selection has X / Y }. */
const mergeState = (page, { localId, xId, yId }) => page.evaluate(async ({ localId, xId, yId }) => {
  const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
  const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
  const pack = game.packs.get(SyncEngine.PACK_ID);
  const y = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === yId);
  const player = game.users.find(u => !u.isGM);
  const a = localId ? game.actors.get(localId) : null;
  return {
    mergedInto: y?.flags?.omnipresence?.mergedInto ?? null,
    localExists: !!a,
    localOmniId: a?.flags?.omnipresence?.id ?? null,
    localEnrolled: a ? SyncRegistry.isEnrolled(a) : null,
    bio: a?.system?.details?.biography?.value ?? null,
    hasX: SyncRegistry.isDocSelected(player.id, 'actor', xId),
    hasY: SyncRegistry.isDocSelected(player.id, 'actor', yId)
  };
}, { localId, xId, yId });

test('merge Y→X as GM leaves a stub and one local actor', async () => {
  const name = `${PREFIX} Merge`;
  const xId = await seedPack(gmPage, { name, bio: 'ORIGINAL', ownerName: playerName });
  const yId = await seedPack(gmPage, { name, bio: 'DUP', ownerName: playerName });
  const localId = await seedEnrolledLocal(gmPage, { name, bio: 'DUP', omniId: yId, ownerName: playerName });
  await link(gmPage, localId, xId, 'shared');
  const s = await mergeState(gmPage, { localId, xId, yId });
  expect(s).toMatchObject({ mergedInto: xId, localOmniId: xId, bio: 'ORIGINAL', hasX: true, hasY: false });
  // The merge's own selection change starts a live import; it must not
  // re-import Y as a duplicate.
  await gmPage.waitForTimeout(2_000);
  expect(await gmPage.evaluate(yId => game.actors.filter(a => a.getFlag('omnipresence', 'id') === yId).length, yId)).toBe(0);
});

test('other world: a stub re-keys a lone Y copy to X', async () => {
  const name = `${PREFIX} Rekey`;
  const xId = await seedPack(gmPage, { name, bio: 'ORIGINAL', ownerName: playerName });
  const yId = await seedPack(gmPage, { name, bio: 'DUP', ownerName: playerName, extraFlags: {} });
  await gmPage.evaluate(async ({ yId, xId }) => {
    const { writeMergeStub } = await import('/modules/omnipresence/scripts/link-actor.js');
    await writeMergeStub(yId, xId);
  }, { yId, xId });
  const localId = await seedEnrolledLocal(gmPage, { name, bio: 'DUP', omniId: yId, ownerName: playerName });
  await gmPage.evaluate(async () => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    await SyncEngine.onLogin();
  });
  const s = await mergeState(gmPage, { localId, xId, yId });
  expect(s).toMatchObject({ mergedInto: xId, localExists: true, localOmniId: xId, bio: 'ORIGINAL', hasX: true, hasY: false });
});

test('other world: Y is deleted when X also exists and Y is clean', async () => {
  const name = `${PREFIX} BothClean`;
  const xId = await seedPack(gmPage, { name, bio: 'ORIGINAL', ownerName: playerName });
  const yId = await seedPack(gmPage, { name, bio: 'DUP', ownerName: playerName });
  await gmPage.evaluate(async ({ yId, xId }) => {
    const { writeMergeStub } = await import('/modules/omnipresence/scripts/link-actor.js');
    await writeMergeStub(yId, xId);
  }, { yId, xId });
  await seedEnrolledLocal(gmPage, { name, bio: 'ORIGINAL', omniId: xId, ownerName: playerName });
  const localY = await seedEnrolledLocal(gmPage, { name, bio: 'DUP', omniId: yId, ownerName: playerName });
  await gmPage.evaluate(async () => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    await SyncEngine.onLogin();
  });
  const s = await mergeState(gmPage, { localId: localY, xId, yId });
  expect(s).toMatchObject({ localExists: false, hasX: true, hasY: false });
});

test('other world: Y with unpushed changes is kept and unenrolled', async () => {
  const name = `${PREFIX} BothDirty`;
  const xId = await seedPack(gmPage, { name, bio: 'ORIGINAL', ownerName: playerName });
  const yId = await seedPack(gmPage, { name, bio: 'DUP', ownerName: playerName });
  await gmPage.evaluate(async ({ yId, xId }) => {
    const { writeMergeStub } = await import('/modules/omnipresence/scripts/link-actor.js');
    await writeMergeStub(yId, xId);
  }, { yId, xId });
  await seedEnrolledLocal(gmPage, { name, bio: 'ORIGINAL', omniId: xId, ownerName: playerName });
  const localY = await seedEnrolledLocal(gmPage, { name, bio: 'DUP', omniId: yId, ownerName: playerName, dirty: true });
  await gmPage.evaluate(async () => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    await SyncEngine.onLogin();
  });
  const s = await mergeState(gmPage, { localId: localY, xId, yId });
  expect(s).toMatchObject({ localExists: true, localEnrolled: false, bio: 'DUP', hasY: false });
});

test.describe('player merge', () => {
  let playerContext, playerPage;
  test.beforeAll(async () => {
    playerContext = await browser.newContext();
    playerPage = await playerContext.newPage();
    await loginToFoundry(playerPage, playerName);
  });
  test.afterAll(async () => { await playerContext?.close(); });

  test('a forged merge request for another user\'s copy is rejected', async () => {
    const victim = await seedPack(gmPage, { name: `${PREFIX} Victim`, bio: 'GM-OWNED' });
    const mine = await seedPack(gmPage, { name: `${PREFIX} Mine`, bio: 'MINE', ownerName: playerName });
    await playerPage.evaluate(async ({ victim, mine }) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      await SyncRegistry.addPendingMerge(game.user.id, { from: victim, to: mine });
    }, { victim, mine });
    await expect.poll(() => gmPage.evaluate(async () => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      return SyncRegistry.getPendingMerges(game.users.find(u => !u.isGM).id).length;
    }), { timeout: 8_000 }).toBe(0);
    const s = await mergeState(gmPage, { localId: null, xId: mine, yId: victim });
    expect(s.mergedInto).toBeNull();
    expect(await packBio(gmPage, victim)).toBe('GM-OWNED');
  });

  test('player merge with GM connected writes the stub within 5s', async () => {
    const name = `${PREFIX} PlayerMerge`;
    const xId = await seedPack(gmPage, { name, bio: 'ORIGINAL', ownerName: playerName });
    const yId = await seedPack(gmPage, { name, bio: 'DUP', ownerName: playerName });
    const localId = await seedEnrolledLocal(gmPage, { name, bio: 'DUP', omniId: yId, ownerName: playerName });
    await playerPage.waitForFunction(id => !!game.actors.get(id), localId, { timeout: 10_000 });
    await link(playerPage, localId, xId, 'shared');
    try {
      await expect.poll(async () => (await mergeState(gmPage, { localId, xId, yId })).mergedInto, { timeout: 8_000 }).toBe(xId);
    } catch (e) {
      const diag = async () => gmPage.evaluate(async ({ yId }) => {
        const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
        const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
        const p = game.users.find(u => !u.isGM);
        const pack = game.packs.get(SyncEngine.PACK_ID);
        const y = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === yId);
        return { pending: SyncRegistry.getPendingMerges(p.id), activeGM: game.users.activeGM?.name ?? null, me: game.user.name, yFlags: y?.flags?.omnipresence };
      }, { yId });
      console.log('DIAG3', JSON.stringify(await diag()), 'GM console:', JSON.stringify(gmErrors.slice(-10)));
      await gmPage.waitForTimeout(10_000);
      console.log('DIAG3 +10s', JSON.stringify(await diag()));
      throw e;
    }
  });
});
