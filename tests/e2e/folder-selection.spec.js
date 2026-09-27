// tests/e2e/folder-selection.spec.js — the folder mode (prefs.folders) and
// allow-list: "every folder" admits roots a saved list leaves out, "chosen"
// does not; an undecided user is asked at login; the User Config setting
// imports at once; marking/deleting never freezes an absent list; the
// picker locks folders in "every folder" mode and fits the screen.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';
import { buildTree, cleanup, ROOT_NAME, PACK } from './folder-helpers.js';

let browser, gmContext, gmPage, saved;

const setFolderState = (page, { mode, folderIds }) => page.evaluate(async ({ mode, folderIds }) => {
  const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
  await SyncRegistry.setSelection(game.user.id, { folderIds });
  if (mode) await SyncRegistry.setPrefs(game.user.id, { folders: mode });
  else await game.user.update({ 'flags.omnipresence.prefs.-=folders': null });
}, { mode, folderIds });

const getFolderState = page => page.evaluate(() => {
  const ids = game.user.getFlag('omnipresence', 'selection')?.folderIds;
  return { mode: game.user.getFlag('omnipresence', 'prefs')?.folders ?? null, folderIds: Array.isArray(ids) ? ids : null };
});

const markProbe = page => page.evaluate(async ROOT_NAME => {
  const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
  return FolderSync.markFolder(game.folders.getName(ROOT_NAME));
}, ROOT_NAME);

// Simulate the other world: the pack tree exists, nothing local.
const dropLocalCopies = page => page.evaluate(async ROOT_NAME => {
  for (const j of game.journal.filter(j => j.name.startsWith(ROOT_NAME))) await j.delete({ omnipresenceInternal: true });
  for (const f of game.folders.filter(f => f.name.startsWith(ROOT_NAME) && f.name !== ROOT_NAME)) await f.delete({ omnipresenceInternal: true });
  for (const f of game.folders.filter(f => f.name === ROOT_NAME)) await f.delete({ omnipresenceInternal: true });
}, ROOT_NAME);

// A root that exists only in the pack, as if shared from another world.
const packOnlyRoot = async page => {
  await buildTree(page);
  const rootId = await markProbe(page);
  await dropLocalCopies(page);
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

test('"every folder" imports a root a saved list leaves out; "chosen" does not', async () => {
  try {
    const rootId = await packOnlyRoot(gmPage);
    await setFolderState(gmPage, { mode: 'chosen', folderIds: [] });
    expect(await reconcileAndFindRoot(gmPage, rootId)).toBe(false);
    await setFolderState(gmPage, { mode: 'all', folderIds: [] });
    expect(await reconcileAndFindRoot(gmPage, rootId)).toBe(true);
  } finally {
    await cleanup(gmPage);
  }
});

test('marking and deleting never freeze an absent list, so a folder shared again imports', async () => {
  try {
    await setFolderState(gmPage, { mode: null, folderIds: null });
    await buildTree(gmPage);
    const firstId = await markProbe(gmPage);
    expect((await getFolderState(gmPage)).folderIds).toBe(null);

    // "Remove Folder" on the synced root: the pack tree goes away.
    await gmPage.evaluate(async ROOT_NAME => { await game.folders.getName(ROOT_NAME).delete(); }, ROOT_NAME);
    await expect.poll(
      () => gmPage.evaluate(({ PACK, id }) => !game.packs.get(PACK).folders.get(id), { PACK, id: firstId }),
      { timeout: 20_000, message: 'pack tree of the removed root is gone' }
    ).toBe(true);
    expect((await getFolderState(gmPage)).folderIds).toBe(null);

    // The source world shares the folder again: a new root id.
    await cleanup(gmPage);
    const secondId = await packOnlyRoot(gmPage);
    expect(secondId).not.toBe(firstId);
    expect(await reconcileAndFindRoot(gmPage, secondId)).toBe(true);
  } finally {
    await cleanup(gmPage);
  }
});

test('an undecided user is asked at login and the choice is saved', async () => {
  await setFolderState(gmPage, { mode: null, folderIds: [] });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await loginToFoundry(page, 'Gamemaster');
    const prompt = page.locator('.omnipresence-folder-mode-prompt');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.locator('button[data-action="all"]').click();
    await expect.poll(() => getFolderState(page).then(s => s.mode), { timeout: 10_000 }).toBe('all');
  } finally {
    await context.close();
  }
});

test('switching User Config to "every folder" imports a left-out root at once', async () => {
  try {
    const rootId = await packOnlyRoot(gmPage);
    await setFolderState(gmPage, { mode: 'chosen', folderIds: [] });
    await gmPage.evaluate(() => game.user.sheet.render(true));
    const select = gmPage.locator('select[name="omnipresence-folder-mode"]');
    await expect(select).toHaveValue('chosen');
    await select.selectOption('all');
    await expect.poll(() => hasRoot(gmPage, rootId), { timeout: 20_000 }).toBe(true);
    expect((await getFolderState(gmPage)).mode).toBe('all');
  } finally {
    await gmPage.evaluate(() => game.user.sheet.close());
    await cleanup(gmPage);
  }
});

test('the picker locks folders in "every folder" mode, keeps the saved list, and fits the screen', async () => {
  try {
    const rootId = await packOnlyRoot(gmPage);
    await setFolderState(gmPage, { mode: 'all', folderIds: ['keepMe'] });
    await gmPage.evaluate(async () => {
      const { DocPicker } = await import('/modules/omnipresence/scripts/doc-picker.js');
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      window.__omniPicker = DocPicker.open({
        mode: 'manage',
        preselected: SyncRegistry.getSelection(game.user.id),
        folderMode: SyncRegistry.getPrefs(game.user.id).folders
      });
    });
    const dialog = gmPage.locator('.omnipresence-picker');
    await expect(dialog).toBeVisible();
    const row = dialog.locator(`[data-list="folder"] [data-row][data-id="${rootId}"] input`);
    await expect(row).toBeChecked();
    await expect(row).toBeDisabled();
    await expect(dialog.locator('[data-folder-mode="all"]')).toBeVisible();

    // The body scrolls; Save stays on screen.
    expect(await dialog.locator('.dialog-content').evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
    const save = dialog.locator('button[data-action="confirm"]');
    await expect(save).toBeInViewport();
    await save.click();
    const result = await gmPage.evaluate(() => window.__omniPicker);
    expect(result.folderMode).toBe('all');
    expect(result.folderIds).toBe(null);
    await expect(dialog).toHaveCount(0);
  } finally {
    await cleanup(gmPage);
  }
});

test('the first-run picker asks for the folder mode; "only the folders I tick" unlocks the list', async () => {
  try {
    const rootId = await packOnlyRoot(gmPage);
    await gmPage.evaluate(async () => {
      const { DocPicker } = await import('/modules/omnipresence/scripts/doc-picker.js');
      window.__omniPicker = DocPicker.open({ mode: 'onboarding', preselected: null });
    });
    const dialog = gmPage.locator('.omnipresence-picker');
    const row = dialog.locator(`[data-list="folder"] [data-row][data-id="${rootId}"] input`);
    await expect(dialog.locator('input[name="omnipresence-folder-mode"][value="all"]')).toBeChecked();
    await expect(row).toBeDisabled();

    await dialog.locator('input[name="omnipresence-folder-mode"][value="chosen"]').check();
    await expect(row).toBeEnabled();
    await row.uncheck();
    await dialog.locator('button[data-action="confirm"]').click();
    const result = await gmPage.evaluate(() => window.__omniPicker);
    expect(result.folderMode).toBe('chosen');
    expect(result.folderIds).not.toContain(rootId);
    await expect(dialog).toHaveCount(0);
  } finally {
    await cleanup(gmPage);
  }
});
