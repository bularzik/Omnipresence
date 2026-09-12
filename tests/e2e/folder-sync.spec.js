// tests/e2e/folder-sync.spec.js — Increment 1: mark a folder, pack tree,
// import into an empty "target" world, unmark.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';
import { buildTree, cleanup, PACK, ROOT_NAME, SUB_NAME } from './folder-helpers.js';

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

test('marking a folder mirrors its tree and members into the pack', async () => {
  try {
    await buildTree(gmPage);
    const result = await gmPage.evaluate(async ({ PACK, ROOT_NAME, SUB_NAME }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      const root = game.folders.getName(ROOT_NAME);
      const rootId = await FolderSync.markFolder(root);
      const sub = game.folders.getName(SUB_NAME);
      const pack = game.packs.get(PACK);
      const packRoot = pack.folders.get(rootId);
      const packSub = pack.folders.get(sub.getFlag('omnipresence', 'id'));
      const docs = await pack.getDocuments();
      const byName = n => docs.find(d => d.name === n);
      const j1 = game.journal.getName(`${ROOT_NAME} J1`);
      return {
        rootFlags: root.flags.omnipresence,
        subFlags: sub.flags.omnipresence,
        packRootParent: packRoot ? packRoot._source.folder : 'missing',
        packRootOwner: packRoot?.getFlag('omnipresence', 'ownerName'),
        packSubParent: packSub ? packSub._source.folder : 'missing',
        packSubColor: packSub?._source.color,
        j1Via: j1.getFlag('omnipresence', 'viaFolder'),
        j1PackFolder: byName(`${ROOT_NAME} J1`)?._source.folder,
        j2PackFolder: byName(`${ROOT_NAME} J2`)?._source.folder,
        registry: game.settings.get('omnipresence', 'syncRegistry')[rootId] === true,
        selected: game.user.getFlag('omnipresence', 'selection')?.folderIds?.includes(rootId)
      };
    }, { PACK, ROOT_NAME, SUB_NAME });

    expect(result.rootFlags.root).toBe(true);
    expect(result.rootFlags.enrolled).toBe(true);
    expect(result.rootFlags.ownerName).toBe(null);
    expect(result.rootFlags.syncedAt).toBeTruthy();
    expect(result.subFlags.rootId).toBe(result.rootFlags.id);
    expect(result.packRootParent).toBe(null);
    expect(result.packRootOwner).toBe(null);
    expect(result.packSubParent).toBe(result.rootFlags.id);
    expect(result.packSubColor).toBe('#336699');
    expect(result.j1Via).toBe(result.rootFlags.id);
    expect(result.j1PackFolder).toBe(result.rootFlags.id);
    expect(result.j2PackFolder).toBe(result.subFlags.id);
    expect(result.registry).toBe(true);
    expect(result.selected).toBe(true);
  } finally {
    await cleanup(gmPage);
  }
});

test('an empty target world imports the tree and members from the pack', async () => {
  try {
    await buildTree(gmPage);
    const result = await gmPage.evaluate(async ({ PACK, ROOT_NAME, SUB_NAME }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      const root = game.folders.getName(ROOT_NAME);
      const rootId = await FolderSync.markFolder(root);
      const subOmni = game.folders.getName(SUB_NAME).getFlag('omnipresence', 'id');
      const j2Omni = game.journal.getName(`${ROOT_NAME} J2`).getFlag('omnipresence', 'id');

      // Simulate another world: nothing local, but the pack tree exists.
      // omnipresenceInternal so no hook treats this as a source-world delete.
      for (const j of game.journal.filter(j => j.name.startsWith(ROOT_NAME))) await j.delete({ omnipresenceInternal: true });
      await game.folders.getName(SUB_NAME).delete({ omnipresenceInternal: true });
      await root.delete({ omnipresenceInternal: true });

      await FolderSync.reconcileFolders();

      const newRoot = game.folders.getName(ROOT_NAME);
      const newSub = game.folders.getName(SUB_NAME);
      const j1 = game.journal.getName(`${ROOT_NAME} J1`);
      const j2 = game.journal.getName(`${ROOT_NAME} J2`);
      return {
        rootRecreated: !!newRoot && newRoot.getFlag('omnipresence', 'id') === rootId && newRoot.folder === null,
        subRecreated: !!newSub && newSub.getFlag('omnipresence', 'id') === subOmni && newSub.folder?.id === newRoot?.id && newSub.color?.css === '#336699',
        j1Placed: j1?.folder?.id === newRoot?.id && j1.getFlag('omnipresence', 'viaFolder') === rootId,
        j2Placed: j2?.folder?.id === newSub?.id && j2.getFlag('omnipresence', 'id') === j2Omni,
        j2Content: j2?.pages.contents[0]?.text?.content
      };
    }, { PACK, ROOT_NAME, SUB_NAME });

    expect(result.rootRecreated).toBe(true);
    expect(result.subRecreated).toBe(true);
    expect(result.j1Placed).toBe(true);
    expect(result.j2Placed).toBe(true);
    expect(result.j2Content).toContain('two');
  } finally {
    await cleanup(gmPage);
  }
});

test('unmarking removes the pack tree and leaves local copies in place', async () => {
  try {
    await buildTree(gmPage);
    const result = await gmPage.evaluate(async ({ PACK, ROOT_NAME, SUB_NAME }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const root = game.folders.getName(ROOT_NAME);
      const rootId = await FolderSync.markFolder(root);
      await FolderSync.unmarkFolder(root);
      const pack = game.packs.get(PACK);
      const docs = await pack.getDocuments();
      const j1 = game.journal.getName(`${ROOT_NAME} J1`);
      return {
        packRootGone: !pack.folders.get(rootId),
        packDocsGone: !docs.some(d => d.name.startsWith(ROOT_NAME)),
        localRootStays: !!game.folders.getName(ROOT_NAME) && root.getFlag('omnipresence', 'root') === undefined,
        localSubStays: !!game.folders.getName(SUB_NAME),
        j1Stays: !!j1 && !SyncRegistry.isEnrolled(j1) && j1.folder?.id === root.id,
        registryGone: game.settings.get('omnipresence', 'syncRegistry')[rootId] === undefined
      };
    }, { PACK, ROOT_NAME, SUB_NAME });
    expect(result).toEqual({
      packRootGone: true, packDocsGone: true, localRootStays: true,
      localSubStays: true, j1Stays: true, registryGone: true
    });
  } finally {
    await cleanup(gmPage);
  }
});
