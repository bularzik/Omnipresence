// tests/e2e/security.spec.js — the 2026-10-11 security review, pinned. Each
// test FAILS on origin/main @ 90bc79d (where the problem exists) and PASSES
// on the branch. The browser side uses only APIs both builds have — pack ids,
// pack.configure, SyncEngine.push, FolderSync.markFolder — so the same file
// runs against either install. Needs Gamemaster and User 1; no other GM
// client may be connected (the active GM must be this one).
//
// Every negative assertion first waits until the GM client has observed the
// attack (the forged flag, the delete, the hotbar entry), then waits one
// debounce window for the GM's push to land. Test 4 also has a positive
// control: an owned macro on the same hotbar must publish.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry, newGmSession, sweepProbes } from './helpers.js';
import { HIDDEN_PACK_OWNERSHIP } from '../../scripts/security-logic.js';

const PLAYER = 'User 1';
const PREFIX = 'Omni Security Probe';
const GM_ONLY_SLOT = 48;
const OWNED_SLOT = 49;
const PUSH_WINDOW_MS = 8_000;
const JOURNALS = 'omnipresence.omnipresence-journals';
const MACROS = 'omnipresence.omnipresence-macros';
let browser, gmCtx, gmPage, playerCtx, playerPage, prevSlots;

const openGm = async () => ({ ctx: gmCtx, page: gmPage } = await newGmSession(browser));

// pack.visible of the three Omnipresence packs World B loads, as seen by `page`'s user.
const packVisibility = page => page.evaluate(({ JOURNALS, MACROS }) => [
  `omnipresence.omnipresence-${game.system.id}`, MACROS, JOURNALS
].map(id => game.packs.get(id)?.visible ?? null), { JOURNALS, MACROS });

test.beforeAll(async () => {
  browser = await chromium.launch();
  await openGm();
  playerCtx = await browser.newContext();
  playerPage = await playerCtx.newPage();
  await loginToFoundry(playerPage, PLAYER);
  prevSlots = await playerPage.evaluate(slots => Object.fromEntries(slots.map(s => [s, game.user.hotbar[s] ?? null])), [GM_ONLY_SLOT, OWNED_SLOT]);
});

test.afterAll(async () => {
  await playerPage?.evaluate(async (prev) => {
    const update = {};
    for (const [slot, id] of Object.entries(prev)) {
      if (id) update[`hotbar.${slot}`] = id;
      else update[`hotbar.-=${slot}`] = null;
    }
    await game.user.update(update, { omnipresenceInternal: true });
  }, prevSlots ?? {}).catch(() => {});
  if (gmPage) await sweepProbes(gmPage, PREFIX).catch(() => {});
  await playerCtx?.close();
  await gmCtx?.close();
  await browser?.close();
});

test('the Omnipresence packs are hidden from a player, and a world override is reset at the next GM login (#3)', async () => {
  test.setTimeout(120_000);
  // 1. Hidden in the player's UI.
  expect(await packVisibility(playerPage)).toEqual([false, false, false]);

  // 2. A world GM opens the journals pack to players: it shows for them.
  await gmPage.evaluate(id => game.packs.get(id).configure({ ownership: { PLAYER: 'OBSERVER', ASSISTANT: 'OWNER' } }), JOURNALS);
  await expect.poll(() => playerPage.evaluate(id => game.packs.get(id).visible, JOURNALS), { timeout: 15_000 }).toBe(true);

  // 3. The next GM login hides it again and says so.
  await gmCtx.close();
  await openGm();
  await expect.poll(() => gmPage.evaluate(id => game.packs.get(id).ownership, JOURNALS), { timeout: 30_000 })
    .toMatchObject({ ...HIDDEN_PACK_OWNERSHIP }); // Foundry's getter adds GAMEMASTER: OWNER
  await expect.poll(() => playerPage.evaluate(id => game.packs.get(id).visible, JOURNALS), { timeout: 15_000 }).toBe(false);
  await expect(gmPage.locator('#notifications .notification', { hasText: 'hidden from players again' })).toBeVisible({ timeout: 10_000 });
});

test("a player's forged sync id cannot overwrite another document's shared copy (#1)", async () => {
  test.setTimeout(90_000);
  const setup = await gmPage.evaluate(async ({ PREFIX, PLAYER }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    // Same actor type for both: a type change could make the overwrite fail
    // validation on main and pass this test for the wrong reason.
    const victim = await Actor.create({ name: `${PREFIX} Victim`, type: 'character' });
    const victimOmni = await SyncRegistry.enroll(victim);
    await SyncEngine.push(victim);
    const player = game.users.getName(PLAYER);
    const forger = await Actor.create({
      name: `${PREFIX} Forger`, type: 'character',
      ownership: { default: 0, [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
    });
    return { victimOmni, forgerId: forger.id };
  }, { PREFIX, PLAYER });

  // Every pack copy carrying the victim's id, by name.
  const victimCopies = () => gmPage.evaluate(async (omniId) => {
    const pack = game.packs.get(`omnipresence.omnipresence-${game.system.id}`);
    return (await pack.getDocuments()).filter(d => d.getFlag('omnipresence', 'id') === omniId).map(d => d.name);
  }, setup.victimOmni);
  await expect.poll(victimCopies, { timeout: 15_000 }).toEqual([`${PREFIX} Victim`]);

  // The attack: stamp the victim's sync id on an actor the player owns, then edit it.
  await playerPage.waitForFunction(id => !!game.actors.get(id), setup.forgerId, { timeout: 15_000 });
  await playerPage.evaluate(async ({ forgerId, victimOmni }) => {
    const forger = game.actors.get(forgerId);
    await forger.update({
      'flags.omnipresence.id': victimOmni,
      'flags.omnipresence.enrolled': true,
      'flags.omnipresence.syncedAt': new Date(0).toISOString()
    });
    await forger.update({ name: `${forger.name} Was Here` });
  }, setup);

  // The GM client has seen the forged flag and the edit; its debounced push follows.
  await gmPage.waitForFunction(({ forgerId, victimOmni }) => {
    const a = game.actors.get(forgerId);
    return a?.getFlag('omnipresence', 'id') === victimOmni && a.name.endsWith('Was Here');
  }, setup, { timeout: 15_000 });
  await gmPage.waitForTimeout(PUSH_WINDOW_MS);
  expect(await victimCopies()).toEqual([`${PREFIX} Victim`]);
});

test('an unbound carrier of an id whose shared copy another document made is not pulled over at login (cross-world race)', async () => {
  test.setTimeout(90_000);
  const result = await gmPage.evaluate(async ({ PREFIX }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const built = game.settings.get('omnipresence', 'bindingsBuilt');
    // The forger's document wins the first push: it is bound to X and makes the copy.
    const forger = await Actor.create({ name: `${PREFIX} Race Forger`, type: 'character' });
    const omniId = await SyncRegistry.enroll(forger);
    await SyncEngine.push(forger);
    const pack = game.packs.get(`omnipresence.omnipresence-${game.system.id}`);
    const copyExists = (await pack.getDocuments()).some(d => d.getFlag('omnipresence', 'id') === omniId);
    // The victim carries X, enrolled, older than the copy, but is not bound to it.
    const victim = await Actor.create({
      name: `${PREFIX} Race Victim`, type: 'character',
      flags: { omnipresence: { id: omniId, enrolled: true, syncedAt: new Date(0).toISOString() } }
    });
    await SyncRegistry.addToSelection(game.user.id, 'actor', omniId);
    const unbound = !Bindings.isBoundTo(victim);
    const before = { name: victim.name, syncedAt: victim.getFlag('omnipresence', 'syncedAt') };
    await SyncEngine.onLogin();
    const copyCount = (await pack.getDocuments()).filter(d => d.getFlag('omnipresence', 'id') === omniId).length;
    const recorded = game.settings.get('omnipresence', 'bindingDuplicates')?.[omniId] ?? null;
    return {
      built, copyExists, unbound, copyCount, before, recorded, omniId, victimId: victim.id,
      after: { name: game.actors.get(victim.id).name, syncedAt: game.actors.get(victim.id).getFlag('omnipresence', 'syncedAt') }
    };
  }, { PREFIX });

  expect(result.built).toBe(true);
  expect(result.copyExists).toBe(true);
  expect(result.unbound).toBe(true);
  expect(result.copyCount).toBe(1);
  expect(result.after).toEqual(result.before);
  expect(result.recorded).toEqual([{ type: 'Actor', id: result.victimId }, { type: 'SharedCopy', id: result.omniId }]);
  // Probes (and the recorded entry) are cleaned up here as well as by the final sweep.
  await gmPage.evaluate(async ({ PREFIX, omniId }) => {
    const dup = { ...(game.settings.get('omnipresence', 'bindingDuplicates') ?? {}) };
    delete dup[omniId];
    await game.settings.set('omnipresence', 'bindingDuplicates', dup);
  }, result);
  await sweepProbes(gmPage, PREFIX);
});

test('a forged viaFolder flag cannot delete a shared journal (#2)', async () => {
  test.setTimeout(90_000);
  const setup = await gmPage.evaluate(async ({ PREFIX, PLAYER }) => {
    const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
    const root = await CONFIG.Folder.documentClass.create({ name: `${PREFIX} Root`, type: 'JournalEntry' });
    const member = await JournalEntry.create({
      name: `${PREFIX} Member`, folder: root.id,
      pages: [{ name: 'p', type: 'text', text: { content: '<p>keep me</p>' } }]
    });
    const rootId = await FolderSync.markFolder(root);
    const player = game.users.getName(PLAYER);
    const forger = await JournalEntry.create({
      name: `${PREFIX} Forger Journal`,
      ownership: { default: 0, [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
    });
    return { rootId, memberOmni: game.journal.get(member.id).getFlag('omnipresence', 'id'), forgerId: forger.id };
  }, { PREFIX, PLAYER });

  const memberCopies = () => gmPage.evaluate(async ({ omniId, JOURNALS }) =>
    (await game.packs.get(JOURNALS).getDocuments()).filter(d => d.getFlag('omnipresence', 'id') === omniId).length,
  { omniId: setup.memberOmni, JOURNALS });
  await expect.poll(memberCopies, { timeout: 20_000 }).toBe(1);

  // The attack: the member's id and root on the player's own journal, then delete it.
  await playerPage.waitForFunction(id => !!game.journal.get(id), setup.forgerId, { timeout: 15_000 });
  await playerPage.evaluate(async ({ forgerId, memberOmni, rootId }) => {
    const forger = game.journal.get(forgerId);
    // omnipresenceInternal keeps every client's update hooks quiet: only the delete acts.
    await forger.update({
      'flags.omnipresence.id': memberOmni,
      'flags.omnipresence.viaFolder': rootId,
      'flags.omnipresence.enrolled': true
    }, { omnipresenceInternal: true });
    await forger.delete();
  }, setup);

  // The GM client has seen the delete (its deleteJournalEntry hook fired).
  await gmPage.waitForFunction(id => !game.journal.get(id), setup.forgerId, { timeout: 15_000 });
  await gmPage.waitForTimeout(PUSH_WINDOW_MS);
  expect(await memberCopies()).toBe(1);
  const tombstone = await gmPage.evaluate(({ rootId, memberOmni, JOURNALS }) =>
    game.packs.get(JOURNALS).folders.get(rootId)?.getFlag('omnipresence', 'tombstones')?.[memberOmni] ?? null,
  { ...setup, JOURNALS });
  expect(tombstone).toBeNull();
});

test("a GM-only macro placed on a player's hotbar is not published (#4)", async () => {
  test.setTimeout(60_000);
  const ids = await gmPage.evaluate(async ({ PREFIX, PLAYER }) => {
    const player = game.users.getName(PLAYER);
    const gmOnly = await Macro.create({ name: `${PREFIX} GM Macro`, type: 'script', command: 'console.log("gm only")', ownership: { default: 0 } });
    // Positive control: a macro the GM gave the player ownership of must publish.
    const owned = await Macro.create({
      name: `${PREFIX} Owned Macro`, type: 'chat', command: 'owned',
      ownership: { default: 0, [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
    });
    return { gmOnlyId: gmOnly.id, ownedId: owned.id };
  }, { PREFIX, PLAYER });

  await playerPage.evaluate(async ({ ids, GM_ONLY_SLOT, OWNED_SLOT }) => {
    await game.user.update({ [`hotbar.${GM_ONLY_SLOT}`]: ids.gmOnlyId, [`hotbar.${OWNED_SLOT}`]: ids.ownedId });
  }, { ids, GM_ONLY_SLOT, OWNED_SLOT });

  // The GM client has seen both hotbar entries; one push handles both.
  await gmPage.waitForFunction(({ PLAYER, ids, GM_ONLY_SLOT, OWNED_SLOT }) => {
    const bar = game.users.getName(PLAYER).hotbar;
    return bar[GM_ONLY_SLOT] === ids.gmOnlyId && bar[OWNED_SLOT] === ids.ownedId;
  }, { PLAYER, ids, GM_ONLY_SLOT, OWNED_SLOT }, { timeout: 15_000 });

  const published = name => gmPage.evaluate(async ({ MACROS, name, PLAYER }) =>
    (await game.packs.get(MACROS).getDocuments())
      .filter(d => d.name === name && d.getFlag('omnipresence', 'ownerName') === PLAYER).length,
  { MACROS, name, PLAYER });

  await expect.poll(() => published(`${PREFIX} Owned Macro`), { timeout: 20_000, message: 'the owned control macro should publish' }).toBe(1);
  expect(await published(`${PREFIX} GM Macro`)).toBe(0);
});
