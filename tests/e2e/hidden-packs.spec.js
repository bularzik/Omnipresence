// tests/e2e/hidden-packs.spec.js — behaviour with the packs hidden from
// players: a player pulls their own update from a hidden pack with no GM
// online; a GM confirms a script macro changed elsewhere before it installs;
// documents sharing a sync id are listed in the dashboard and refused until
// the GM keeps one. Needs Gamemaster and User 1, and no other GM client (the
// first test runs with no GM at all).
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry, newGmSession, sweepProbes, foreignDuplicateSets } from './helpers.js';

const PLAYER = 'User 1';
const PREFIX = 'Omni Hidden Probe';
const CONFIRM_SLOT = 47;
const JOURNALS = 'omnipresence.omnipresence-journals';
let browser, gmCtx, gmPage, prevGmSlot;

// `ready` does not wait for the login reconcile, which would otherwise run (and
// could open a confirm dialog) in the middle of a test; join it, then clear
// whatever dialogs it left.
const openGm = async () => {
  ({ ctx: gmCtx, page: gmPage } = await newGmSession(browser));
  await gmPage.evaluate(async () => {
    const { runLoginReconcile } = await import('/modules/omnipresence/scripts/reconcile.js');
    await runLoginReconcile();
  });
  await closeForeignDialogs(true);
};

// Other modules (e.g. Campaign Companion) raise their own warning dialogs at
// login, which can sit over the confirm dialog's buttons. Close every dialog
// that is not ours before clicking.
const closeForeignDialogs = (includeOurs = false) => gmPage.evaluate(async (includeOurs) => {
  for (const app of [...foundry.applications.instances.values()]) {
    if (!app.element?.matches?.('dialog')) continue;
    if (includeOurs || !app.element.classList.contains('omnipresence-macro-confirm')) await app.close();
  }
}, includeOurs);

test.beforeAll(async () => {
  browser = await chromium.launch();
  await openGm();
  await sweepProbes(gmPage, PREFIX);
  // A stale probe macro would have opened a confirm dialog during that login.
  await closeForeignDialogs(true);
  prevGmSlot = await gmPage.evaluate(slot => game.user.hotbar[slot] ?? null, CONFIRM_SLOT);
});

test.afterAll(async () => {
  if (gmPage && !gmPage.isClosed()) {
    await gmPage.evaluate(async ({ SLOT, prev }) => {
      await game.user.update(prev ? { [`hotbar.${SLOT}`]: prev } : { [`hotbar.-=${SLOT}`]: null }, { omnipresenceInternal: true });
    }, { SLOT: CONFIRM_SLOT, prev: prevGmSlot }).catch(() => {});
    await sweepProbes(gmPage, PREFIX).catch(() => {});
  }
  await gmCtx?.close();
  await browser?.close();
});

test('a player pulls their own update from a hidden pack with no GM online', async () => {
  test.setTimeout(180_000);
  const setup = await gmPage.evaluate(async ({ PREFIX, PLAYER, JOURNALS }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    // A pack folder, so the folder comparison below is not 0 === 0.
    await CONFIG.Folder.documentClass.create({ name: `${PREFIX} Pack Folder`, type: 'JournalEntry' }, { pack: JOURNALS });
    const player = game.users.getName(PLAYER);
    const actor = await Actor.create({
      name: `${PREFIX} Self`, type: 'character',
      ownership: { default: 0, [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
    });
    const omniId = await SyncRegistry.enroll(actor);
    await SyncEngine.push(actor);
    // Another world pushed a newer version: rename the pack copy and move its
    // syncedAt past the local one.
    const pack = game.packs.get(SyncEngine.PACK_ID);
    const copy = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
    await copy.update({
      name: `${PREFIX} Self Remote`,
      'flags.omnipresence.syncedAt': new Date(Date.now() + 60_000).toISOString()
    }, { omnipresenceInternal: true });
    return { actorId: actor.id, gmFolderCount: game.packs.get(JOURNALS).folders.size };
  }, { PREFIX, PLAYER, JOURNALS });
  expect(setup.gmFolderCount).toBeGreaterThan(0);

  await gmCtx.close();
  const playerCtx = await browser.newContext();
  const playerPage = await playerCtx.newPage();
  try {
    await loginToFoundry(playerPage, PLAYER);
    await playerPage.waitForFunction(() => !game.users.activeGM, null, { timeout: 30_000 });
    // Hidden from the player, yet their own update arrives.
    expect(await playerPage.evaluate(() => game.packs.get(`omnipresence.omnipresence-${game.system.id}`).visible)).toBe(false);
    await expect.poll(() => playerPage.evaluate(id => game.actors.get(id)?.name, setup.actorId), { timeout: 30_000 })
      .toBe(`${PREFIX} Self Remote`);
    // Folder-member gating reads pack.folders on the player client: the hidden
    // journals pack must still carry its folders for them.
    expect(await playerPage.evaluate(id => game.packs.get(id).folders.size, JOURNALS)).toBe(setup.gmFolderCount);
  } finally {
    await playerCtx.close();
    await openGm();
  }
});

test('a GM confirms a script macro changed in another world before it installs', async () => {
  test.setTimeout(90_000);
  const omniId = await gmPage.evaluate(async ({ PREFIX, SLOT }) => {
    const omniId = foundry.utils.randomID(16);
    await Macro.create({
      name: `${PREFIX} Confirm`, type: 'script', command: 'console.log("omni v1")',
      flags: { omnipresence: { id: omniId, ownerName: game.user.name, hotbarSlots: [SLOT], originWorld: 'omni-elsewhere' } }
    }, { pack: 'omnipresence.omnipresence-macros' });
    return omniId;
  }, { PREFIX, SLOT: CONFIRM_SLOT });

  const pull = () => gmPage.evaluate(async () => {
    const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
    await MacroSync.pullOwn();
  });
  const setPackCommand = command => gmPage.evaluate(async ({ omniId, command }) => {
    const docs = await game.packs.get('omnipresence.omnipresence-macros').getDocuments();
    await docs.find(d => d.getFlag('omnipresence', 'id') === omniId).update({ command });
  }, { omniId, command });
  const local = () => gmPage.evaluate(omniId => {
    const m = game.macros.find(m => m.getFlag('omnipresence', 'id') === omniId);
    if (!m) return null;
    const slot = Object.entries(game.user.hotbar).find(([, id]) => id === m.id)?.[0] ?? null;
    return { command: m.command, slot };
  }, omniId);
  const dialog = gmPage.locator('.omnipresence-macro-confirm', { hasText: `${PREFIX} Confirm` });

  // 1. New here: asked first, nothing installed until the GM says so.
  await pull();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('omni-elsewhere');
  await expect(dialog).toContainText('omni v1');
  expect(await local()).toBeNull();
  await closeForeignDialogs();
  await dialog.locator('button[data-action="install"]').click();
  await expect.poll(local, { timeout: 10_000 }).toEqual({ command: 'console.log("omni v1")', slot: String(CONFIRM_SLOT) });
  // The closing dialog lingers in the DOM during its animation.
  await expect(dialog).toHaveCount(0);

  // 2. Changed elsewhere: asked again; Skip keeps the local command.
  await setPackCommand('console.log("omni v2")');
  await pull();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('omni v2');
  await closeForeignDialogs();
  await dialog.locator('button[data-action="skip"]').click();
  await expect(dialog).toBeHidden();
  expect((await local()).command).toBe('console.log("omni v1")');

  // 3. An approved command is not asked about again: back to v1, deleted
  //    locally, pulled → installs silently.
  await setPackCommand('console.log("omni v1")');
  await gmPage.evaluate(async omniId => {
    for (const m of game.macros.filter(m => m.getFlag('omnipresence', 'id') === omniId)) await m.delete();
  }, omniId);
  await pull();
  await expect.poll(local, { timeout: 10_000 }).toEqual({ command: 'console.log("omni v1")', slot: String(CONFIRM_SLOT) });
  await expect(dialog).toHaveCount(0);
});

test('documents sharing a sync id that the upgrade cannot settle are listed and refused until the GM keeps one', async () => {
  test.setTimeout(90_000);
  const ids = await gmPage.evaluate(async (PREFIX) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const keep = await Actor.create({ name: `${PREFIX} Dup Keep`, type: 'npc' });
    const omniId = await SyncRegistry.enroll(keep);
    await SyncEngine.push(keep);
    // A pre-upgrade duplicate the upgrade cannot settle by itself: the two
    // carriers belong to two different players (different ownership, neither
    // GM-only). Internal writes: no hook may push or clear the id.
    const owned = name => ({ default: 0, [game.users.getName(name).id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
    await keep.update({ ownership: owned('User 1') }, { omnipresenceInternal: true });
    const extra = await Actor.create({
      name: `${PREFIX} Dup Extra`, type: 'npc', ownership: owned('User 2'),
      flags: { omnipresence: { id: omniId, enrolled: true } }
    }, { omnipresenceInternal: true });
    return { omniId, keepId: keep.id, extraId: extra.id };
  }, PREFIX);

  // Never replay the build over real documents: it would settle their sets too.
  const foreign = await foreignDuplicateSets(gmPage, [ids.omniId]);
  test.skip(foreign.length > 0, `World has duplicate sync ids outside this test; not replaying the upgrade: ${foreign.join('; ')}`);
  // Replay the first-login build as an upgraded world would see it.
  await gmPage.evaluate(async (omniId) => {
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const map = { ...game.settings.get('omnipresence', 'bindings') };
    delete map[omniId];
    await game.settings.set('omnipresence', 'bindings', map);
    await game.settings.set('omnipresence', 'bindingsBuilt', false);
    await Bindings.init();
  }, ids.omniId);

  const copyName = () => gmPage.evaluate(async (omniId) => {
    const pack = game.packs.get(`omnipresence.omnipresence-${game.system.id}`);
    return (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId)?.name ?? null;
  }, ids.omniId);
  const renameAndPush = name => gmPage.evaluate(async ({ keepId, name }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const a = game.actors.get(keepId);
    await a.update({ name }, { omnipresenceInternal: true });
    await SyncEngine.push(a);
  }, { keepId: ids.keepId, name });
  // The survivor belongs to User 1, so its gate user (from real ownership) is User 1.
  const selected = () => gmPage.evaluate(async (omniId) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    return SyncRegistry.isDocSelected(game.users.getName('User 1').id, 'actor', omniId);
  }, ids.omniId);

  // Refused while duplicated.
  await renameAndPush(`${PREFIX} Dup Keep Edited`);
  expect(await copyName()).toBe(`${PREFIX} Dup Keep`);

  // Listed in the dashboard.
  await gmPage.evaluate(async () => {
    const { OmnipresenceDashboard } = await import('/modules/omnipresence/scripts/gm-dashboard.js');
    new OmnipresenceDashboard().render(true);
  });
  const list = gmPage.locator('.omnipresence-duplicates');
  await expect(list).toContainText(`${PREFIX} Dup Keep`, { timeout: 10_000 });
  await expect(list).toContainText(`${PREFIX} Dup Extra`);

  // The GM keeps the original (confirming over the existing shared copy): the
  // list clears, the extra loses the id, the survivor is back on its gate
  // user's allow-list (so login reconcile syncs it too), and its push lands.
  await closeForeignDialogs();
  await list.locator(`a[data-action="keepDuplicate"][data-doc-id="${ids.keepId}"]`).click();
  const confirm = gmPage.locator('.omnipresence-keep-confirm');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.locator('button[data-action="yes"]').click();
  await expect(list).toHaveCount(0, { timeout: 10_000 });
  expect(await gmPage.evaluate(id => game.actors.get(id)?.getFlag('omnipresence', 'id') ?? null, ids.extraId)).toBeNull();
  await expect.poll(selected, { timeout: 10_000 }).toBe(true);
  await renameAndPush(`${PREFIX} Dup Keep Edited`);
  expect(await copyName()).toBe(`${PREFIX} Dup Keep Edited`);
  await gmPage.evaluate(async (omniId) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    foundry.applications.instances.get('omnipresence-dashboard')?.close();
    // The probe's binding and allow-list entries go with it (the sweep removes the documents).
    const bindings = { ...(game.settings.get('omnipresence', 'bindings') ?? {}) };
    delete bindings[omniId];
    await game.settings.set('omnipresence', 'bindings', bindings);
    for (const u of game.users) await SyncRegistry.removeFromSelection(u.id, 'actor', omniId);
  }, ids.omniId);
});
