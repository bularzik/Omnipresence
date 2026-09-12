// tests/e2e/folder-membership.spec.js — Increment 2: membership mirroring.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';
import { PACK, ROOT_NAME, SUB_NAME, buildAndMark, cleanup, packState } from './folder-helpers.js';

const DEBOUNCE_WAIT_MS = 4_000;

let browser, gmContext, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
});

test.afterAll(async () => {
  await gmContext?.close();
  await browser?.close();
});

test('a journal created inside a synced subfolder joins the sync', async () => {
  try {
    const { rootId, subOmni } = await buildAndMark(gmPage);
    await gmPage.evaluate(async ({ ROOT_NAME, SUB_NAME }) => {
      await JournalEntry.create({ name: `${ROOT_NAME} J3`, folder: game.folders.getName(SUB_NAME).id });
    }, { ROOT_NAME, SUB_NAME });
    await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);
    const local = await gmPage.evaluate(({ ROOT_NAME }) => {
      const j = game.journal.getName(`${ROOT_NAME} J3`);
      return { via: j.getFlag('omnipresence', 'viaFolder'), enrolled: j.getFlag('omnipresence', 'enrolled') };
    }, { ROOT_NAME });
    expect(local).toEqual({ via: rootId, enrolled: true });
    const pack = await packState(gmPage, rootId);
    expect(pack.foldersByName[`${ROOT_NAME} J3`]).toBe(subOmni);
  } finally {
    await cleanup(gmPage);
  }
});

test('moving a journal out unenrolls it, drops the pack copy, and tombstones it as removed', async () => {
  try {
    const { rootId } = await buildAndMark(gmPage);
    const omniId = await gmPage.evaluate(async ({ ROOT_NAME }) => {
      const j = game.journal.getName(`${ROOT_NAME} J1`);
      const id = j.getFlag('omnipresence', 'id');
      await j.update({ folder: null });
      return id;
    }, { ROOT_NAME });
    await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);
    const local = await gmPage.evaluate(async ({ ROOT_NAME }) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const j = game.journal.getName(`${ROOT_NAME} J1`);
      return { enrolled: SyncRegistry.isEnrolled(j), via: j.getFlag('omnipresence', 'viaFolder') ?? null, exists: !!j };
    }, { ROOT_NAME });
    expect(local).toEqual({ enrolled: false, via: null, exists: true });
    const pack = await packState(gmPage, rootId);
    expect(pack.names).toEqual([`${ROOT_NAME} J2`]);
    expect(pack.tombstones?.[omniId]?.reason).toBe('removed');
  } finally {
    await cleanup(gmPage);
  }
});

test('deleting a member drops the pack copy and tombstones it as deleted', async () => {
  try {
    const { rootId } = await buildAndMark(gmPage);
    const omniId = await gmPage.evaluate(async ({ ROOT_NAME }) => {
      const j = game.journal.getName(`${ROOT_NAME} J2`);
      const id = j.getFlag('omnipresence', 'id');
      await j.delete();
      return id;
    }, { ROOT_NAME });
    await gmPage.waitForTimeout(1_000);
    const pack = await packState(gmPage, rootId);
    expect(pack.names).toEqual([`${ROOT_NAME} J1`]);
    expect(pack.tombstones?.[omniId]?.reason).toBe('deleted');
  } finally {
    await cleanup(gmPage);
  }
});

test('re-adding a tombstoned journal prunes its tombstone', async () => {
  try {
    const { rootId } = await buildAndMark(gmPage);
    const omniId = await gmPage.evaluate(async ({ ROOT_NAME }) => {
      const j = game.journal.getName(`${ROOT_NAME} J1`);
      await j.update({ folder: null });
      return j.getFlag('omnipresence', 'id');
    }, { ROOT_NAME });
    await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);
    expect((await packState(gmPage, rootId)).tombstones?.[omniId]?.reason).toBe('removed');
    await gmPage.evaluate(async ({ ROOT_NAME }) => {
      await game.journal.getName(`${ROOT_NAME} J1`).update({ folder: game.folders.getName(ROOT_NAME).id });
    }, { ROOT_NAME });
    await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);
    const pack = await packState(gmPage, rootId);
    expect(pack.names).toEqual([`${ROOT_NAME} J1`, `${ROOT_NAME} J2`]);
    expect(pack.tombstones?.[omniId]).toBeUndefined();
  } finally {
    await cleanup(gmPage);
  }
});

test('renaming and reparenting a subfolder mirrors to the pack', async () => {
  try {
    const { rootId, subOmni } = await buildAndMark(gmPage);
    const sub2Omni = await gmPage.evaluate(async ({ ROOT_NAME, SUB_NAME }) => {
      const root = game.folders.getName(ROOT_NAME);
      const sub2 = await CONFIG.Folder.documentClass.create({ name: `${ROOT_NAME} Sub2`, type: 'JournalEntry', folder: root.id });
      await new Promise(r => setTimeout(r, 500)); // let createFolder stamp it
      const sub = game.folders.getName(SUB_NAME);
      await sub.update({ name: `${SUB_NAME} Renamed`, folder: sub2.id });
      return game.folders.get(sub2.id).getFlag('omnipresence', 'id');
    }, { ROOT_NAME, SUB_NAME });
    await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);
    const pack = await gmPage.evaluate(({ PACK, subOmni, sub2Omni }) => {
      const pack = game.packs.get(PACK);
      const s = pack.folders.get(subOmni);
      return { name: s?._source.name, parent: s?._source.folder, sub2Exists: !!pack.folders.get(sub2Omni) };
    }, { PACK, subOmni, sub2Omni });
    expect(pack).toEqual({ name: `${SUB_NAME} Renamed`, parent: sub2Omni, sub2Exists: true });
  } finally {
    await cleanup(gmPage);
  }
});

test('deleting the root with contents flags the pack root deleted and empties it', async () => {
  try {
    const { rootId } = await buildAndMark(gmPage);
    await gmPage.evaluate(async ({ ROOT_NAME }) => {
      await game.folders.getName(ROOT_NAME).delete({ deleteSubfolders: true, deleteContents: true });
    }, { ROOT_NAME });
    await gmPage.waitForTimeout(2_000);
    const pack = await packState(gmPage, rootId);
    expect(pack.deleted).toBe(true);
    expect(pack.names).toEqual([]);
    expect(pack.packFolderNames).toEqual([ROOT_NAME]);
    expect(Object.values(pack.tombstones ?? {}).map(t => t.reason)).toEqual(['deleted', 'deleted']);
  } finally {
    await cleanup(gmPage);
  }
});

test('a target world applies tombstones: deleted → gone, removed → detached; deleted root → mirror removed', async () => {
  try {
    const { rootId } = await buildAndMark(gmPage);
    // Source-side actions: delete J1, move J2 out.
    const ids = await gmPage.evaluate(async ({ ROOT_NAME }) => {
      const j1 = game.journal.getName(`${ROOT_NAME} J1`);
      const j2 = game.journal.getName(`${ROOT_NAME} J2`);
      const out = { j1: j1.getFlag('omnipresence', 'id'), j2: j2.getFlag('omnipresence', 'id') };
      await j1.delete();
      await j2.update({ folder: null });
      return out;
    }, { ROOT_NAME });
    await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);

    // Pretend to be the target world that still holds both as members.
    const applied = await gmPage.evaluate(async ({ ROOT_NAME, rootId, ids }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const root = game.folders.getName(ROOT_NAME);
      const j2 = game.journal.getName(`${ROOT_NAME} J2`);
      await j2.update({ folder: root.id, 'flags.omnipresence.enrolled': true, 'flags.omnipresence.viaFolder': rootId }, { omnipresenceInternal: true });
      await JournalEntry.create({ name: `${ROOT_NAME} J1`, folder: root.id, flags: { omnipresence: { id: ids.j1, enrolled: true, viaFolder: rootId } } }, { omnipresenceInternal: true });
      await FolderSync.reconcileFolders();
      const j1After = game.journal.getName(`${ROOT_NAME} J1`);
      const j2After = game.journal.getName(`${ROOT_NAME} J2`);
      return {
        j1Gone: !j1After,
        j2Detached: !!j2After && j2After.folder === null && !SyncRegistry.isEnrolled(j2After)
      };
    }, { ROOT_NAME, rootId, ids });
    expect(applied).toEqual({ j1Gone: true, j2Detached: true });

    // Now delete the root with contents, then rebuild a mirror and reconcile.
    const mirror = await gmPage.evaluate(async ({ ROOT_NAME, SUB_NAME, rootId }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      await game.folders.getName(ROOT_NAME).delete({ deleteSubfolders: true, deleteContents: true });
      await new Promise(r => setTimeout(r, 1500));
      const Folder = CONFIG.Folder.documentClass;
      const root = await Folder.create({ name: ROOT_NAME, type: 'JournalEntry', flags: { omnipresence: { id: rootId, enrolled: true, root: true, ownerName: null, syncedAt: new Date().toISOString() } } }, { omnipresenceInternal: true });
      await Folder.create({ name: SUB_NAME, type: 'JournalEntry', folder: root.id, flags: { omnipresence: { id: foundry.utils.randomID(16), rootId } } }, { omnipresenceInternal: true });
      await JournalEntry.create({ name: `${ROOT_NAME} J9`, folder: root.id, flags: { omnipresence: { id: foundry.utils.randomID(16), enrolled: true, viaFolder: rootId } } }, { omnipresenceInternal: true });
      await FolderSync.reconcileFolders();
      return {
        rootGone: !game.folders.getName(ROOT_NAME),
        subGone: !game.folders.getName(SUB_NAME),
        j9Gone: !game.journal.getName(`${ROOT_NAME} J9`)
      };
    }, { ROOT_NAME, SUB_NAME, rootId });
    expect(mirror).toEqual({ rootGone: true, subGone: true, j9Gone: true });
  } finally {
    await cleanup(gmPage);
  }
});
