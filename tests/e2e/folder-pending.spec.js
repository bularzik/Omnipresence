// tests/e2e/folder-pending.spec.js — op-vxk: the player pending path. Players
// cannot write Folder documents, so a player's mark, move-out, delete and
// unmark are recorded on their own User document / journals and honoured by a
// GM: immediately while one is connected (updateUser hook), otherwise at the
// next GM login (materializePending). This is the only path that turns non-GM
// input into GM pack writes.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';
import { PACK, ROOT_NAME, cleanup, packState, waitForPackState } from './folder-helpers.js';

const PLAYER = 'User 1';
let browser, gmCtx, gmPage, playerCtx, playerPage;

const newGm = async () => {
  gmCtx = await browser.newContext();
  gmPage = await gmCtx.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
};

test.beforeAll(async () => {
  browser = await chromium.launch();
  await newGm();
  playerCtx = await browser.newContext();
  playerPage = await playerCtx.newPage();
  await loginToFoundry(playerPage, PLAYER);
});

test.afterAll(async () => {
  if (gmPage && !gmPage.isClosed()) await cleanup(gmPage).catch(() => {});
  await playerCtx?.close();
  await gmCtx?.close();
  await browser?.close();
});

test('player mark → connected GM materializes; move-out with GM; move-out + delete without GM → next GM login drains; player unmark', async () => {
  test.setTimeout(180_000);
  // 1. GM builds a folder of three journals owned by the player.
  const { folderId, ids } = await gmPage.evaluate(async ({ ROOT_NAME, PLAYER }) => {
    const owner = game.users.getName(PLAYER);
    const ownership = { default: 0, [owner.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
    const folder = await CONFIG.Folder.documentClass.create({ name: ROOT_NAME, type: 'JournalEntry' });
    const ids = {};
    for (const n of ['J1', 'J2', 'J3']) {
      const j = await JournalEntry.create({ name: `${ROOT_NAME} ${n}`, folder: folder.id, ownership });
      ids[n] = j.id;
    }
    return { folderId: folder.id, ids };
  }, { ROOT_NAME, PLAYER });

  // 2. Player marks it: members enrolled viaFolder, pending mark recorded.
  await playerPage.waitForFunction((id) => !!game.folders.get(id) && game.journal.filter(j => j.folder?.id === id).length === 3, folderId, { timeout: 15_000 });
  const rootId = await playerPage.evaluate(async ({ folderId }) => {
    const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
    return FolderSync.markFolder(game.folders.get(folderId));
  }, { folderId });
  expect(rootId).toBeTruthy();
  const pendingSeen = await playerPage.evaluate(({ rootId }) => game.user.getFlag('omnipresence', 'pendingRoots')?.[rootId]?.action, { rootId });
  expect(pendingSeen).toBe('mark');

  // 3. The connected GM materializes: root stamped with the player's name, tree + members in the pack.
  await expect.poll(() => gmPage.evaluate(({ folderId }) => {
    const f = game.folders.get(folderId);
    return { root: f?.getFlag('omnipresence', 'root'), owner: f?.getFlag('omnipresence', 'ownerName') };
  }, { folderId }), { timeout: 20_000, message: 'GM should stamp the pending mark' }).toEqual({ root: true, owner: PLAYER });
  await waitForPackState(gmPage, rootId, s => s.names.length === 3 && s.packFolderNames.includes(ROOT_NAME), 'members should be pushed');
  await expect.poll(() => playerPage.evaluate(({ rootId }) => game.user.getFlag('omnipresence', 'pendingRoots')?.[rootId] ?? null, { rootId }), { timeout: 10_000 }).toBeNull();

  // 4. Move J1 out while the GM is connected: the GM tombstones it as removed.
  const j1Omni = await playerPage.evaluate(async ({ id }) => { const j = game.journal.get(id); await j.update({ folder: null }); return j.getFlag('omnipresence', 'id'); }, { id: ids.J1 });
  await waitForPackState(gmPage, rootId, s => s.tombstones?.[j1Omni]?.reason === 'removed' && s.names.length === 2, 'GM should mirror the move-out');

  // 5. GM leaves. With no GM connected the player records pendingRemove (J2) and a pending delete (J3).
  await gmCtx.close();
  await playerPage.waitForFunction(() => !game.users.activeGM, null, { timeout: 30_000 });
  const pend = await playerPage.evaluate(async ({ ids }) => {
    const j2 = game.journal.get(ids.J2); const j3 = game.journal.get(ids.J3);
    const out = { j2Omni: j2.getFlag('omnipresence', 'id'), j3Omni: j3.getFlag('omnipresence', 'id') };
    await j2.update({ folder: null });
    await j3.delete();
    await new Promise(r => setTimeout(r, 500));
    out.pendingRemove = game.journal.get(ids.J2).getFlag('omnipresence', 'pendingRemove');
    out.pendingDeletes = game.user.getFlag('omnipresence', 'pendingDeletes');
    return out;
  }, { ids });
  expect(pend.pendingRemove).toBe(rootId);
  expect(pend.pendingDeletes).toEqual([{ omniId: pend.j3Omni, rootId }]);

  // 6. A fresh GM login drains both into tombstones and clears the records.
  await newGm();
  const drained = await waitForPackState(gmPage, rootId, s => s.tombstones?.[pend.j2Omni]?.reason === 'removed' && s.tombstones?.[pend.j3Omni]?.reason === 'deleted', 'GM login should drain pending remove + delete');
  expect(drained.names).toEqual([]);
  await expect.poll(() => playerPage.evaluate(({ id }) => ({
    pendingRemove: game.journal.get(id)?.getFlag('omnipresence', 'pendingRemove') ?? null,
    pendingDeletes: game.user.getFlag('omnipresence', 'pendingDeletes') ?? []
  }), { id: ids.J2 }), { timeout: 10_000 }).toEqual({ pendingRemove: null, pendingDeletes: [] });

  // 7. Player unmarks: queued for the connected GM, who unstamps and drops the pack tree.
  await playerPage.evaluate(async ({ folderId }) => {
    const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
    await FolderSync.unmarkFolder(game.folders.get(folderId));
  }, { folderId });
  await expect.poll(() => gmPage.evaluate(({ folderId, PACK, rootId }) => ({
    stamped: !!game.folders.get(folderId)?.getFlag('omnipresence', 'root'),
    packRoot: !!game.packs.get(PACK).folders.get(rootId)
  }), { folderId, PACK, rootId }), { timeout: 20_000, message: 'GM should honour the pending unmark' }).toEqual({ stamped: false, packRoot: false });
});
