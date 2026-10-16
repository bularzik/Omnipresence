// tests/e2e/upgrade-duplicates.spec.js — documents that share a sync id, as
// an upgraded world and Foundry's Duplicate produce them. At the one-time
// bindings build nothing that shares an id is bound automatically (every
// signal can be forged); sets are listed with advisory hints and settled by
// the GM's "Keep this one".
//   (a) an honest sidebar-style Duplicate: listed with the "duplicated from"
//       hint, nothing bound or detached; Keep on the original settles it and
//       its edits push again; a pull leaves the local _stats alone;
//   (b) a forgery whose victim carries a doctored duplicateSource (as a
//       pre-upgrade pull would have brought it): listed, nothing detached;
//       Keep re-stamps the kept document's ownerName so login reconcile's
//       gate user has it on their allow-list;
//   (b2) an enrolled original + an unenrolled copy with a shared copy: listed,
//       not auto-bound;
//   (c) a Duplicate made after the upgrade never inherits a bound id;
//   (d) the dashboard's "Keep this one" settles a listed row;
//   (e) a copy made with no GM connected is cleared at the next GM login;
//   (f) a binding whose document lost the id while another carries it is
//       listed, nothing detached.
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
const enrolledPushedActor = (name, extra = {}) => gmPage.evaluate(async ({ name, extra }) => {
  const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
  const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
  const actor = await Actor.create({ name, type: 'npc', ...extra });
  const omniId = await SyncRegistry.enroll(actor);
  await SyncEngine.push(actor);
  return { omniId, id: actor.id, uuid: actor.uuid };
}, { name, extra });

// A copy of `id` carrying all its flags, created the way a pre-upgrade world
// holds one (internal, so no create hook runs). Fresh _id and _stats.
const preUpgradeCopy = (id, name, { ownership = null, flags = {} } = {}) => gmPage.evaluate(async ({ id, name, ownership, flags }) => {
  const data = game.actors.get(id).toObject();
  delete data._id;
  delete data._stats;
  data.name = name;
  Object.assign(data.flags.omnipresence, flags);
  if (ownership) data.ownership = Object.fromEntries(Object.entries(ownership).map(([n, l]) => [n === 'default' ? n : game.users.getName(n).id, l]));
  return (await Actor.create(data, { omnipresenceInternal: true })).id;
}, { id, name, ownership, flags });

// Replay the first-login build as an upgraded world would see it — never over
// real documents: any duplicate set or recorded row other than the probe's
// skips the test.
const replayUpgrade = async omniId => {
  const foreign = await foreignDuplicateSets(gmPage, [...omniIds, omniId]);
  test.skip(foreign.length > 0, `World has duplicate sync ids outside this test; not replaying the upgrade: ${foreign.join('; ')}`);
  return gmPage.evaluate(async (omniId) => {
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const map = { ...game.settings.get('omnipresence', 'bindings') };
    delete map[omniId];
    await game.settings.set('omnipresence', 'bindings', map);
    await game.settings.set('omnipresence', 'bindingsBuilt', false);
    await Bindings.init();
    return game.settings.get('omnipresence', 'bindingsBuilt');
  }, omniId);
};

const actorState = (omniId, ids) => gmPage.evaluate(async ({ omniId, ids }) => {
  const pack = game.packs.get(`omnipresence.omnipresence-${game.system.id}`);
  const copy = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
  return {
    binding: game.settings.get('omnipresence', 'bindings')?.[omniId] ?? null,
    record: game.settings.get('omnipresence', 'bindingDuplicates')?.[omniId] ?? null,
    ids: Object.fromEntries(ids.map(id => [id, game.actors.get(id)?.getFlag('omnipresence', 'id') ?? null])),
    copy: copy ? { name: copy.name, syncedAt: copy.getFlag('omnipresence', 'syncedAt') } : null
  };
}, { omniId, ids });

const openDashboard = () => gmPage.evaluate(async () => {
  for (const app of [...foundry.applications.instances.values()]) if (app.element?.matches?.('dialog')) await app.close();
  const { OmnipresenceDashboard } = await import('/modules/omnipresence/scripts/gm-dashboard.js');
  await foundry.applications.instances.get('omnipresence-dashboard')?.close();
  await new OmnipresenceDashboard().render(true);
});
const closeDashboard = () => gmPage.evaluate(() => foundry.applications.instances.get('omnipresence-dashboard')?.close());
const row = id => gmPage.locator(`.omnipresence-duplicates > li[data-omni-id="${id}"]`);
const keepWithConfirm = async (omniId, docId) => {
  await row(omniId).locator(`a[data-action="keepDuplicate"][data-doc-id="${docId}"]`).click();
  const confirm = gmPage.locator('.omnipresence-keep-confirm');
  await expect(confirm).toBeVisible({ timeout: 10_000 });
  await confirm.locator('button[data-action="yes"]').click();
  await expect(row(omniId)).toHaveCount(0, { timeout: 10_000 });
};

test('(a) an honest Duplicate present at the upgrade is listed with a hint; Keep on the original settles it', async () => {
  test.setTimeout(90_000);
  const orig = await enrolledPushedActor(`${PREFIX} Honest`);
  omniIds.add(orig.omniId);
  // What the sidebar Duplicate does (addSource records _stats.duplicateSource),
  // made internal so no create hook clears it: the world before the upgrade.
  const cloneId = await gmPage.evaluate(async ({ id, name }) =>
    (await game.actors.get(id).clone({ name }, { save: true, addSource: true, omnipresenceInternal: true })).id,
  { id: orig.id, name: `${PREFIX} Honest Copy` });
  expect(await replayUpgrade(orig.omniId)).toBe(true);

  const state = await actorState(orig.omniId, [orig.id, cloneId]);
  expect(state.binding).toBeNull();
  expect(state.ids).toEqual({ [orig.id]: orig.omniId, [cloneId]: orig.omniId });
  expect(state.record).toEqual([{ type: 'Actor', id: orig.id }, { type: 'Actor', id: cloneId }, { type: 'SharedCopy', id: orig.omniId }]);

  await openDashboard();
  await expect(row(orig.omniId)).toContainText(`${PREFIX} Honest Copy`, { timeout: 10_000 });
  await expect(row(orig.omniId).locator(`li[data-doc-id="${cloneId}"] .omnipresence-duplicated-from`)).toContainText(`${PREFIX} Honest`);
  await expect(row(orig.omniId).locator(`li[data-doc-id="${orig.id}"] .omnipresence-duplicated-from`)).toHaveCount(0);

  await keepWithConfirm(orig.omniId, orig.id);
  await closeDashboard();
  const after = await actorState(orig.omniId, [orig.id, cloneId]);
  expect(after.binding).toEqual({ type: 'Actor', id: orig.id });
  expect(after.ids).toEqual({ [orig.id]: orig.omniId, [cloneId]: null });

  // An edit to the original pushes.
  await gmPage.evaluate(async ({ id, name }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const a = game.actors.get(id);
    await a.update({ name }, { omnipresenceInternal: true });
    await SyncEngine.push(a);
  }, { id: orig.id, name: `${PREFIX} Honest Edited` });
  expect((await actorState(orig.omniId, [])).copy.name).toBe(`${PREFIX} Honest Edited`);
});

test('(b) a forgery with a doctored duplicateSource is listed with nothing detached; Keep re-stamps ownerName', async () => {
  test.setTimeout(90_000);
  // The forger's document is older; the victim carries a duplicateSource that
  // names it (as a pre-upgrade pull of the forger's copy would have set).
  const forger = await gmPage.evaluate(async ({ name, PLAYER }) => {
    const u = game.users.getName(PLAYER);
    const a = await Actor.create({ name, type: 'npc', ownership: { default: 0, [u.id]: 3 } });
    return { id: a.id, uuid: a.uuid };
  }, { name: `${PREFIX} Forger`, PLAYER });
  const victim = await enrolledPushedActor(`${PREFIX} Victim`, { _stats: { duplicateSource: forger.uuid } });
  omniIds.add(victim.omniId);
  await gmPage.evaluate(async ({ id, omniId }) => {
    await game.actors.get(id).update({
      'flags.omnipresence.id': omniId, 'flags.omnipresence.enrolled': true
    }, { omnipresenceInternal: true });
  }, { id: forger.id, omniId: victim.omniId });
  const before = (await actorState(victim.omniId, [])).copy;
  expect(await replayUpgrade(victim.omniId)).toBe(true);

  const state = await actorState(victim.omniId, [victim.id, forger.id]);
  expect(state.binding).toBeNull();
  expect(state.ids).toEqual({ [victim.id]: victim.omniId, [forger.id]: victim.omniId });
  expect(state.record).not.toBeNull();
  expect(state.copy).toEqual(before);

  // The victim's ownership changed since enroll (its ownerName flag still says
  // GM-owned): Keep re-stamps the flag from real ownership, so the allow-list
  // it lands on is the one login reconcile reads.
  const OTHER = 'User 2';
  await gmPage.evaluate(async ({ id, OTHER }) => {
    const u = game.users.getName(OTHER);
    await game.actors.get(id).update({ ownership: { default: 0, [u.id]: 3 } }, { omnipresenceInternal: true });
  }, { id: victim.id, OTHER });
  await openDashboard();
  // The doctored hint is shown, and it decided nothing.
  await expect(row(victim.omniId).locator(`li[data-doc-id="${victim.id}"] .omnipresence-duplicated-from`)).toContainText(`${PREFIX} Forger`, { timeout: 10_000 });
  await keepWithConfirm(victim.omniId, victim.id);
  await closeDashboard();
  const after = await actorState(victim.omniId, [victim.id, forger.id]);
  expect(after.binding).toEqual({ type: 'Actor', id: victim.id });
  expect(after.ids).toEqual({ [victim.id]: victim.omniId, [forger.id]: null });
  expect(await gmPage.evaluate(async ({ id, omniId }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const a = game.actors.get(id);
    // The same gate user SyncEngine.onLogin resolves from the flag.
    const gate = SyncRegistry.gateUser(a.getFlag('omnipresence', 'ownerName') ?? null);
    return { ownerName: a.getFlag('omnipresence', 'ownerName') ?? null, gate: gate?.name ?? null, selected: !!gate && SyncRegistry.isDocSelected(gate.id, 'actor', omniId) };
  }, { id: victim.id, omniId: victim.omniId })).toEqual({ ownerName: OTHER, gate: OTHER, selected: true });

  // _stats is world-local: a push does not put the victim's duplicateSource
  // on the shared copy, and a pull keeps the local one.
  const stats = await gmPage.evaluate(async ({ id }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const a = game.actors.get(id);
    await SyncEngine.push(a);
    const pack = game.packs.get(SyncEngine.PACK_ID);
    const copy = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === a.getFlag('omnipresence', 'id'));
    await SyncEngine.pull(a, copy);
    return { copy: copy._stats.duplicateSource ?? null, local: game.actors.get(id)._stats.duplicateSource ?? null };
  }, { id: victim.id });
  expect(stats).toEqual({ copy: null, local: forger.uuid });
});

test('(b2) an enrolled original + an unenrolled copy, with a shared copy, is listed rather than auto-bound', async () => {
  test.setTimeout(90_000);
  const orig = await enrolledPushedActor(`${PREFIX} Lone Enrolled`);
  omniIds.add(orig.omniId);
  const copyId = await preUpgradeCopy(orig.id, `${PREFIX} Lone Enrolled Copy`, { flags: { enrolled: false } });
  expect(await replayUpgrade(orig.omniId)).toBe(true);
  const state = await actorState(orig.omniId, [orig.id, copyId]);
  expect(state.binding).toBeNull();
  expect(state.ids).toEqual({ [orig.id]: orig.omniId, [copyId]: orig.omniId });
  expect(state.record).toEqual([{ type: 'Actor', id: orig.id }, { type: 'SharedCopy', id: orig.omniId }]);
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

test('(f) a binding whose document lost its id while another carries it is listed; nothing is detached', async () => {
  test.setTimeout(90_000);
  const orig = await enrolledPushedActor(`${PREFIX} Stale`);
  omniIds.add(orig.omniId);
  const otherId = await preUpgradeCopy(orig.id, `${PREFIX} Stale Other`);
  await gmPage.evaluate(async ({ id }) => {
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    await game.actors.get(id).update({ 'flags.omnipresence.-=id': null }, { omnipresenceInternal: true });
    await Bindings.init();
  }, { id: orig.id });
  const state = await actorState(orig.omniId, [orig.id, otherId]);
  expect(state.binding).toEqual({ type: 'Actor', id: orig.id });
  expect(state.ids).toEqual({ [orig.id]: null, [otherId]: orig.omniId });
  expect(state.record).toEqual([{ type: 'Actor', id: otherId }, { type: 'SharedCopy', id: orig.omniId }]);
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

  await openDashboard();
  await expect(row(plain.omniId)).toContainText(`${PREFIX} Keep A`, { timeout: 10_000 });
  await expect(row(shared.omniId)).toContainText(`${PREFIX} Keep C`);

  // Plain row: keep B (no shared copy, no confirmation).
  await row(plain.omniId).locator(`a[data-action="keepDuplicate"][data-doc-id="${plain.b}"]`).click();
  await expect(row(plain.omniId)).toHaveCount(0, { timeout: 10_000 });
  const plainState = await actorState(plain.omniId, [plain.a, plain.b]);
  expect(plainState.binding).toEqual({ type: 'Actor', id: plain.b });
  expect(plainState.ids).toEqual({ [plain.a]: null, [plain.b]: plain.omniId });
  expect(await gmPage.evaluate(async (omniId) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    return SyncRegistry.isDocSelected(game.user.id, 'actor', omniId);
  }, plain.omniId)).toBe(true);

  // SharedCopy row: a confirmation first, then bound.
  await keepWithConfirm(shared.omniId, shared.c);
  await closeDashboard();
  expect((await actorState(shared.omniId, [shared.c])).binding).toEqual({ type: 'Actor', id: shared.c });
});
