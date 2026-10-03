// tests/e2e/folder-selection.spec.js — explicit per-world folder opt-in: a
// shared folder syncs into a world only once listed there. A folder shared
// from another world shows under "Shared from other worlds" in the Journal
// sidebar with Sync here; the section exists only while something is listed.
// Users from before 0.9.0 keep the folders already here. "Remove Folder"
// clears the pack. The picker fits the screen; first run ticks no folder.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';
import { buildTree, cleanup, ROOT_NAME, PACK } from './folder-helpers.js';

let browser, gmContext, gmPage, saved;

const setFolderIds = (page, folderIds) => page.evaluate(async folderIds => {
  const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
  await SyncRegistry.setSelection(game.user.id, { folderIds });
}, folderIds);

const getFolderIds = page => page.evaluate(() => {
  const ids = game.user.getFlag('omnipresence', 'selection')?.folderIds;
  return Array.isArray(ids) ? ids : null;
});

const markProbe = page => page.evaluate(async ROOT_NAME => {
  const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
  return FolderSync.markFolder(game.folders.getName(ROOT_NAME));
}, ROOT_NAME);

// Simulate the other world: the pack tree exists, nothing local, not chosen here.
const dropLocalCopies = page => page.evaluate(async ROOT_NAME => {
  for (const j of game.journal.filter(j => j.name.startsWith(ROOT_NAME))) await j.delete({ omnipresenceInternal: true });
  for (const f of game.folders.filter(f => f.name.startsWith(ROOT_NAME) && f.name !== ROOT_NAME)) await f.delete({ omnipresenceInternal: true });
  for (const f of game.folders.filter(f => f.name === ROOT_NAME)) await f.delete({ omnipresenceInternal: true });
}, ROOT_NAME);

const sharedFromOtherWorld = async page => {
  await buildTree(page);
  const rootId = await markProbe(page);
  await dropLocalCopies(page);
  await setFolderIds(page, []);
  return rootId;
};

const hasRoot = (page, rootId) => page.evaluate(async rootId => {
  const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
  return !!FolderSync.findRootById(rootId);
}, rootId);

const reconcileAndFindRoot = async (page, rootId) => {
  await page.evaluate(async () => {
    const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
    await FolderSync.reconcileFolders();
  });
  return hasRoot(page, rootId);
};

// A fresh browser context starts with the sidebar collapsed.
const showJournalSidebar = page => page.evaluate(async () => {
  ui.sidebar.toggleExpanded(true);
  ui.sidebar.changeTab('journal', 'primary');
  await ui.journal.render();
});

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext({ viewport: { width: 1280, height: 560 } });
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  saved = await gmPage.evaluate(() => ({
    selection: game.user.getFlag('omnipresence', 'selection') ?? null,
    prefs: game.user.getFlag('omnipresence', 'prefs') ?? null
  }));
});

test.afterAll(async () => {
  // setFlag merges objects, so clear first: a saved value without a key
  // must come back without it.
  await gmPage?.evaluate(async saved => {
    for (const key of ['selection', 'prefs']) {
      await game.user.unsetFlag('omnipresence', key);
      if (saved[key]) await game.user.setFlag('omnipresence', key, saved[key]);
    }
  }, saved);
  await gmContext?.close();
  await browser?.close();
});

test('a folder shared from another world is listed in the Journal sidebar and "Sync here" imports it', async () => {
  try {
    const rootId = await sharedFromOtherWorld(gmPage);
    // Not chosen here: login sync leaves it out.
    expect(await reconcileAndFindRoot(gmPage, rootId)).toBe(false);

    await showJournalSidebar(gmPage);
    const section = gmPage.locator('#journal .omnipresence-shared-folders');
    const row = section.locator(`li[data-root-id="${rootId}"]`);
    await expect(row).toContainText(ROOT_NAME);
    await row.locator('button[data-action="omnipresence-sync-here"]').click();

    await expect.poll(() => hasRoot(gmPage, rootId), { timeout: 20_000 }).toBe(true);
    expect(await getFolderIds(gmPage)).toContain(rootId);
    // Nothing left to offer: the section is gone.
    await expect(section).toHaveCount(0);
  } finally {
    await cleanup(gmPage);
  }
});

test('no list means no folders; a listed folder syncs', async () => {
  try {
    const rootId = await sharedFromOtherWorld(gmPage);
    await setFolderIds(gmPage, null);
    expect(await reconcileAndFindRoot(gmPage, rootId)).toBe(false);
    await setFolderIds(gmPage, [rootId]);
    expect(await reconcileAndFindRoot(gmPage, rootId)).toBe(true);
  } finally {
    await cleanup(gmPage);
  }
});

test('the 0.9.0 upgrade keeps folders already here and drops the 0.8.0 folder mode', async () => {
  try {
    await buildTree(gmPage);
    const rootId = await markProbe(gmPage);
    await gmPage.evaluate(async () => {
      await game.user.unsetFlag('omnipresence', 'selection');
      await game.user.setFlag('omnipresence', 'prefs', { folders: 'all' });
    });
    const after = await gmPage.evaluate(async () => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      await FolderSync.upgradeFolderSelections();
      return {
        folderIds: game.user.getFlag('omnipresence', 'selection')?.folderIds ?? null,
        mode: game.user.getFlag('omnipresence', 'prefs')?.folders ?? null
      };
    });
    expect(after.folderIds).toContain(rootId);
    expect(after.mode).toBe(null);
  } finally {
    await cleanup(gmPage);
  }
});

test('"Remove Folder" on a synced root clears its pack tree', async () => {
  try {
    await buildTree(gmPage);
    const rootId = await markProbe(gmPage);
    await gmPage.evaluate(async ROOT_NAME => { await game.folders.getName(ROOT_NAME).delete(); }, ROOT_NAME);
    await expect.poll(
      () => gmPage.evaluate(({ PACK, id }) => !game.packs.get(PACK).folders.get(id), { PACK, id: rootId }),
      { timeout: 20_000, message: 'pack tree of the removed root is gone' }
    ).toBe(true);
  } finally {
    await cleanup(gmPage);
  }
});

test('the first-run picker ticks no folder and fits the screen', async () => {
  try {
    const rootId = await sharedFromOtherWorld(gmPage);
    await gmPage.evaluate(async () => {
      const { DocPicker } = await import('/modules/omnipresence/scripts/doc-picker.js');
      window.__omniPicker = DocPicker.open({ mode: 'onboarding', preselected: null });
    });
    const dialog = gmPage.locator('.omnipresence-picker');
    const row = dialog.locator(`[data-list="folder"] [data-row][data-id="${rootId}"] input`);
    await expect(row).not.toBeChecked();
    await expect(row).toBeEnabled();

    expect(await dialog.locator('.dialog-content').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
    const confirm = dialog.locator('button[data-action="confirm"]');
    await expect(confirm).toBeInViewport();
    await row.check();
    await confirm.click();
    const result = await gmPage.evaluate(() => window.__omniPicker);
    expect(result.folderIds).toContain(rootId);
    await expect(dialog).toHaveCount(0);
  } finally {
    await cleanup(gmPage);
  }
});
