// tests/e2e/upgrade-duplicates.spec.js — documents that share a sync id, as
// an upgraded world and Foundry's Duplicate produce them:
//   (a) an honest duplicate (a sidebar-style Duplicate, which records
//       _stats.duplicateSource) present at the one-time bindings build keeps
//       syncing: the original is bound, the copy loses the id, nothing listed;
//   (b) a pre-upgrade forgery (a player's actor stamped with a GM actor's
//       id, no Duplicate record) is listed with nothing detached and the
//       shared copy untouched; "Keep this one" then settles it;
//   (c) a Duplicate made after the upgrade never inherits a bound id;
//   (d) the dashboard's "Keep this one" settles a listed row;
//   (e) a copy made with no GM connected is cleared at the next GM login.
// "Before the upgrade" is simulated by deleting the probe's binding and
// re-running Bindings.init() with bindingsBuilt false. Needs the Gamemaster
// only; no other GM client may be connected (the active GM must be this one).
import { test, expect, chromium } from '@playwright/test';
import { newGmSession, sweepProbes, foreignDuplicateSets } from './helpers.js';

const PREFIX = 'TT-Omni Upgrade';
const PLAYER = 'User 1';
let browser, gmCtx, gmPage;
const omniIds = new Set();

test.beforeAll(async () => {
  browser = await chromium.launch();
  ({ ctx: gmCtx, page: gmPage } = await newGmSession(browser));
});

test.afterAll(async () => {
  if (gmPage) {
    await gmPage.evaluate(async (ids) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const bindings = { ...(game.settings.get('omnipresence', 'bindings') ?? {}) };
      const dups = { ...(game.settings.get('omnipresence', 'bindingDuplicates') ?? {}) };
      for (const id of ids) {
        delete bindings[id];
        delete dups[id];
        for (const u of game.users) {
          await SyncRegistry.removeFromSelection(u.id, 'actor', id);
          await SyncRegistry.removeFromSelection(u.id, 'journal', id);
        }
      }
      await game.settings.set('omnipresence', 'bindings', bindings);
      await game.settings.set('omnipresence', 'bindingDuplicates', dups);
      await game.settings.set('omnipresence', 'bindingsBuilt', true);
      await foundry.applications.instances.get('omnipresence-dashboard')?.close();
    }, [...omniIds]).catch(() => {});
    await sweepProbes(gmPage, PREFIX).catch(() => {});
  }
  await gmCtx?.close();
  await browser?.close();
});

// A GM-owned TT- actor, enrolled and pushed: bound, with a GM-owned shared copy.
const enrolledPushedActor = name => gmPage.evaluate(async (name) => {
  const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
  const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
  const actor = await Actor.create({ name, type: 'npc' });
  const omniId = await SyncRegistry.enroll(actor);
  await SyncEngine.push(actor);
  return { omniId, id: actor.id };
}, name);

// A copy of `id` carrying all its flags, created the way a pre-upgrade world
// holds one (internal, so no create hook runs). Fresh _id and _stats.
const preUpgradeCopy = (id, name, ownership = null) => gmPage.evaluate(async ({ id, name, ownership }) => {
  const data = game.actors.get(id).toObject();
  delete data._id;
  delete data._stats;
  data.name = name;
  if (ownership) data.ownership = Object.fromEntries(Object.entries(ownership).map(([n, l]) => [n === 'default' ? n : game.users.getName(n).id, l]));
  return (await Actor.create(data, { omnipresenceInternal: true })).id;
}, { id, name, ownership });

// Replay the first-login build as an upgraded world would see it — never over
// real documents: any duplicate set other than the probe's skips the test.
const replayUpgrade = async omniId => {
  const foreign = await foreignDuplicateSets(gmPage, [omniId]);
  test.skip(foreign.length > 0, `World has duplicate sync ids outside this test; not replaying the upgrade: ${foreign.join('; ')}`);
  return replayBuild(omniId);
};
const replayBuild = omniId => gmPage.evaluate(async (omniId) => {
  const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
  const map = { ...game.settings.get('omnipresence', 'bindings') };
  delete map[omniId];
  await game.settings.set('omnipresence', 'bindings', map);
  await game.settings.set('omnipresence', 'bindingsBuilt', false);
  await Bindings.init();
  return game.settings.get('omnipresence', 'bindingsBuilt');
}, omniId);

const actorState = (omniId, ids) => gmPage.evaluate(async ({ omniId, ids }) => {
  const pack = game.packs.get(`omnipresence.omnipresence-${game.system.id}`);
  const copy = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
  return {
    binding: game.settings.get('omnipresence', 'bindings')?.[omniId] ?? null,
    listed: omniId in (game.settings.get('omnipresence', 'bindingDuplicates') ?? {}),
    ids: Object.fromEntries(ids.map(id => [id, game.actors.get(id)?.getFlag('omnipresence', 'id') ?? null])),
    copy: copy ? { name: copy.name, syncedAt: copy.getFlag('omnipresence', 'syncedAt') } : null
  };
}, { omniId, ids });

test('(a) an honest duplicate present at the upgrade: the original stays bound and keeps pushing, the copy loses the id', async () => {
  test.setTimeout(90_000);
  const orig = await enrolledPushedActor(`${PREFIX} Honest`);
  omniIds.add(orig.omniId);
  // What the sidebar Duplicate does (addSource records _stats.duplicateSource),
  // made internal so no create hook clears it: the world before the upgrade.
  const cloneId = await gmPage.evaluate(async ({ id, name }) =>
    (await game.actors.get(id).clone({ name }, { save: true, addSource: true, omnipresenceInternal: true })).id,
  { id: orig.id, name: `${PREFIX} Honest Copy` });
  expect(await replayUpgrade(orig.omniId)).toBe(true);
  await gmPage.evaluate(async () => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    await SyncEngine.onLogin();
  });

  const state = await actorState(orig.omniId, [orig.id, cloneId]);
  expect(state.binding).toEqual({ type: 'Actor', id: orig.id });
  expect(state.ids).toEqual({ [orig.id]: orig.omniId, [cloneId]: null });
  expect(state.listed).toBe(false);

  // An edit to the original pushes.
  await gmPage.evaluate(async ({ id, name }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const a = game.actors.get(id);
    await a.update({ name }, { omnipresenceInternal: true });
    await SyncEngine.push(a);
  }, { id: orig.id, name: `${PREFIX} Honest Edited` });
  expect((await actorState(orig.omniId, [])).copy.name).toBe(`${PREFIX} Honest Edited`);
});

test('(b) a pre-upgrade forgery is listed, nothing is detached, and Keep settles it', async () => {
  test.setTimeout(90_000);
  const victim = await enrolledPushedActor(`${PREFIX} Victim`);
  omniIds.add(victim.omniId);
  // The forgery carries every flag, the copy's syncedAt included, and its
  // pre-upgrade push re-stamped the copy's ownerName with the forger's name.
  // It has no Duplicate record, so the upgrade cannot tell which is the original.
  const forgerId = await preUpgradeCopy(victim.id, `${PREFIX} Forger`, { default: 0, [PLAYER]: 3 });
  await gmPage.evaluate(async ({ omniId, PLAYER }) => {
    const pack = game.packs.get(`omnipresence.omnipresence-${game.system.id}`);
    const copy = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
    await copy.update({ 'flags.omnipresence.ownerName': PLAYER }, { omnipresenceInternal: true });
  }, { omniId: victim.omniId, PLAYER });
  const before = (await actorState(victim.omniId, [])).copy;
  expect(await replayUpgrade(victim.omniId)).toBe(true);

  const state = await actorState(victim.omniId, [victim.id, forgerId]);
  expect(state.binding).toBeNull();
  expect(state.ids).toEqual({ [victim.id]: victim.omniId, [forgerId]: victim.omniId });
  expect(state.listed).toBe(true);
  expect(state.copy).toEqual(before);

  // The GM keeps the victim. Its ownership changed since enroll (the
  // ownerName flag still says GM-owned): Keep re-stamps the flag from real
  // ownership, so the allow-list it lands on is the one login reconcile reads.
  const OTHER = 'User 2';
  await gmPage.evaluate(async ({ id, OTHER }) => {
    const u = game.users.getName(OTHER);
    await game.actors.get(id).update({ ownership: { default: 0, [u.id]: 3 } }, { omnipresenceInternal: true });
  }, { id: victim.id, OTHER });
  await gmPage.evaluate(async () => {
    const { OmnipresenceDashboard } = await import('/modules/omnipresence/scripts/gm-dashboard.js');
    new OmnipresenceDashboard().render(true);
  });
  const row = gmPage.locator(`.omnipresence-duplicates li[data-omni-id="${victim.omniId}"]`);
  await row.locator(`a[data-action="keepDuplicate"][data-doc-id="${victim.id}"]`).click();
  await expect(row).toHaveCount(0, { timeout: 10_000 });
  const after = await actorState(victim.omniId, [victim.id, forgerId]);
  expect(after.binding).toEqual({ type: 'Actor', id: victim.id });
  expect(after.ids).toEqual({ [victim.id]: victim.omniId, [forgerId]: null });
  expect(await gmPage.evaluate(async ({ id, omniId }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const a = game.actors.get(id);
    // The same gate user SyncEngine.onLogin resolves from the flag.
    const gate = SyncRegistry.gateUser(a.getFlag('omnipresence', 'ownerName') ?? null);
    return { ownerName: a.getFlag('omnipresence', 'ownerName') ?? null, gate: gate?.name ?? null, selected: !!gate && SyncRegistry.isDocSelected(gate.id, 'actor', omniId) };
  }, { id: victim.id, omniId: victim.omniId })).toEqual({ ownerName: OTHER, gate: OTHER, selected: true });
  await gmPage.evaluate(() => foundry.applications.instances.get('omnipresence-dashboard')?.close());
});

test('(c) a Duplicate made after the upgrade never inherits the bound id', async () => {
  test.setTimeout(90_000);
  const orig = await enrolledPushedActor(`${PREFIX} Original`);
  omniIds.add(orig.omniId);
  const cloneId = await gmPage.evaluate(async ({ id, name }) =>
    (await game.actors.get(id).clone({ name }, { save: true })).id,
  { id: orig.id, name: `${PREFIX} Original Duplicate` });

  const cloneOmni = () => gmPage.evaluate(id => game.actors.get(id)?.getFlag('omnipresence', 'id') ?? null, cloneId);
  await expect.poll(cloneOmni, { timeout: 10_000 }).toBeNull();
  const state = await actorState(orig.omniId, [orig.id]);
  expect(state.binding).toEqual({ type: 'Actor', id: orig.id });
  expect(state.ids[orig.id]).toBe(orig.omniId);

  // Same for a journal.
  const journal = await gmPage.evaluate(async (name) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const j = await JournalEntry.create({ name, pages: [{ name: 'p', type: 'text', text: { content: '<p>x</p>' } }] });
    const omniId = await SyncRegistry.enroll(j);
    await JournalSync.push(j);
    const copy = await j.clone({ name: `${name} Duplicate` }, { save: true });
    return { omniId, id: j.id, copyId: copy.id };
  }, `${PREFIX} Journal`);
  omniIds.add(journal.omniId);
  const journalCopyOmni = () => gmPage.evaluate(id => game.journal.get(id)?.getFlag('omnipresence', 'id') ?? null, journal.copyId);
  await expect.poll(journalCopyOmni, { timeout: 10_000 }).toBeNull();
  expect(await gmPage.evaluate(id => game.journal.get(id).getFlag('omnipresence', 'id'), journal.id)).toBe(journal.omniId);
});

test('(e) a copy made while no GM was connected is cleared at the next active-GM login', async () => {
  test.setTimeout(90_000);
  const orig = await enrolledPushedActor(`${PREFIX} Offline`);
  omniIds.add(orig.omniId);
  // Internal create: no create hook runs, as when no GM client saw it.
  const copyId = await preUpgradeCopy(orig.id, `${PREFIX} Offline Copy`);
  await gmPage.evaluate(async () => {
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    await Bindings.init(); // bindingsBuilt is true: only the resolve and the sweep run
  });
  const state = await actorState(orig.omniId, [orig.id, copyId]);
  expect(state.binding).toEqual({ type: 'Actor', id: orig.id });
  expect(state.ids).toEqual({ [orig.id]: orig.omniId, [copyId]: null });
});

test('(d) "Keep this one" in the dashboard binds that document and detaches the others', async () => {
  test.setTimeout(90_000);
  // A listed row: two enrolled carriers of a never-pushed id; a push of one is
  // refused and records both.
  const plain = await gmPage.evaluate(async (PREFIX) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const a = await Actor.create({ name: `${PREFIX} Keep A`, type: 'npc' });
    const omniId = await SyncRegistry.enroll(a);
    const b = await Actor.create({ name: `${PREFIX} Keep B`, type: 'npc', flags: { omnipresence: { id: omniId, enrolled: true } } }, { omnipresenceInternal: true });
    await SyncEngine.push(a);
    return { omniId, a: a.id, b: b.id };
  }, PREFIX);
  omniIds.add(plain.omniId);
  // A SharedCopy row: a copy "from another world" and an unbound local carrier.
  const shared = await gmPage.evaluate(async (PREFIX) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const omniId = foundry.utils.randomID(16);
    await Actor.create({
      name: `${PREFIX} Remote Copy`, type: 'npc',
      flags: { omnipresence: { id: omniId, syncedAt: new Date().toISOString(), ownerName: null } }
    }, { pack: SyncEngine.PACK_ID });
    const c = await Actor.create({
      name: `${PREFIX} Keep C`, type: 'npc',
      flags: { omnipresence: { id: omniId, enrolled: true, syncedAt: new Date(0).toISOString() } }
    }, { omnipresenceInternal: true });
    await SyncRegistry.addToSelection(game.user.id, 'actor', omniId);
    await SyncEngine.onLogin();
    return { omniId, c: c.id };
  }, PREFIX);
  omniIds.add(shared.omniId);

  await gmPage.evaluate(async () => {
    const { OmnipresenceDashboard } = await import('/modules/omnipresence/scripts/gm-dashboard.js');
    new OmnipresenceDashboard().render(true);
  });
  const row = id => gmPage.locator(`.omnipresence-duplicates li[data-omni-id="${id}"]`);
  await expect(row(plain.omniId)).toContainText(`${PREFIX} Keep A`, { timeout: 10_000 });
  await expect(row(shared.omniId)).toContainText(`${PREFIX} Keep C`);

  // Plain row: keep B.
  await row(plain.omniId).locator(`a[data-action="keepDuplicate"][data-doc-id="${plain.b}"]`).click();
  await expect(row(plain.omniId)).toHaveCount(0, { timeout: 10_000 });
  const plainState = await actorState(plain.omniId, [plain.a, plain.b]);
  expect(plainState.binding).toEqual({ type: 'Actor', id: plain.b });
  expect(plainState.ids).toEqual({ [plain.a]: null, [plain.b]: plain.omniId });
  expect(await gmPage.evaluate(async (omniId) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    return SyncRegistry.isDocSelected(game.user.id, 'actor', omniId);
  }, plain.omniId)).toBe(true);

  // SharedCopy row: a confirmation first, then bound. Other modules' login
  // dialogs can sit over its buttons: close them first.
  await gmPage.evaluate(async () => {
    for (const app of [...foundry.applications.instances.values()]) if (app.element?.matches?.('dialog')) await app.close();
  });
  await row(shared.omniId).locator(`a[data-action="keepDuplicate"][data-doc-id="${shared.c}"]`).click();
  const confirm = gmPage.locator('.omnipresence-keep-confirm');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.locator('button[data-action="yes"]').click();
  await expect(row(shared.omniId)).toHaveCount(0, { timeout: 10_000 });
  expect((await actorState(shared.omniId, [shared.c])).binding).toEqual({ type: 'Actor', id: shared.c });
});
