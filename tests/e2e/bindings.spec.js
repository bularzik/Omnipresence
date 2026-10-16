// tests/e2e/bindings.spec.js — shared-copy bindings in the two field shapes
// most likely to break them: parallel pushes of new enrollments (Force Sync
// All) must keep every binding, and a deleted-then-re-imported actor (the
// documented recovery, op-74f) must be re-bound to its new local id and keep
// pushing. Needs only the Gamemaster.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

const NAME = 'Omni Binding Probe';
let browser, ctx, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  ctx = await browser.newContext();
  gmPage = await ctx.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
});

test.afterAll(async () => {
  await gmPage?.evaluate(async (NAME) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    for (const a of game.actors.filter(a => a.name.startsWith(NAME))) { await SyncRegistry.unenroll(a); await a.delete(); }
    const pack = game.packs.get(SyncEngine.PACK_ID);
    for (const d of await pack.getDocuments()) if (d.name.startsWith(NAME)) await d.delete();
  }, NAME).catch(() => {});
  await ctx?.close();
  await browser?.close();
});

test('parallel pushes of new enrollments keep every binding', async () => {
  const bound = await gmPage.evaluate(async (NAME) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const actors = [];
    for (let i = 0; i < 5; i++) {
      const a = await Actor.create({ name: `${NAME} Parallel ${i}`, type: 'npc' });
      await SyncRegistry.enroll(a);
      actors.push(a);
    }
    // The dashboard's Force Sync All shape: every push at once.
    await Promise.all(actors.map(a => SyncEngine.push(a)));
    return actors.map(a => Bindings.isBoundTo(a));
  }, NAME);
  expect(bound).toEqual([true, true, true, true, true]);
});

test('a deleted then re-imported actor is re-bound and keeps pushing', async () => {
  const out = await gmPage.evaluate(async (NAME) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const pack = game.packs.get(SyncEngine.PACK_ID);
    const actor = await Actor.create({ name: `${NAME} Reimport`, type: 'npc' });
    const omniId = await SyncRegistry.enroll(actor);
    await SyncEngine.push(actor);
    const oldId = actor.id;
    await actor.delete();
    await SyncEngine.onLogin(); // re-imports from the pack under a new local id
    const back = game.actors.find(a => a.getFlag('omnipresence', 'id') === omniId);
    await back.update({ name: `${NAME} Reimport Edited` }, { omnipresenceInternal: true });
    await SyncEngine.push(back);
    pack.clear();
    const names = (await pack.getDocuments()).filter(d => d.getFlag('omnipresence', 'id') === omniId).map(d => d.name);
    return { newId: back.id !== oldId, bound: Bindings.isBoundTo(back), names };
  }, NAME);
  expect(out).toEqual({ newId: true, bound: true, names: [`${NAME} Reimport Edited`] });
});

test('a forged carrier of a not-yet-pushed id is refused, not bound (first-push race)', async () => {
  const out = await gmPage.evaluate(async (NAME) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { Bindings } = await import('/modules/omnipresence/scripts/bindings.js');
    const pack = game.packs.get(SyncEngine.PACK_ID);
    // Victim: enrolled, never pushed — unbound and no copy yet.
    const victim = await Actor.create({ name: `${NAME} Victim`, type: 'npc' });
    const omniId = await SyncRegistry.enroll(victim);
    // Attacker stamps the victim's id and enrolled flag on their own actor.
    const forged = await Actor.create({
      name: `${NAME} Forged`, type: 'npc',
      flags: { omnipresence: { id: omniId, enrolled: true } }
    });
    await SyncEngine.push(forged);
    const binding = Bindings.get(omniId);
    const copies = (await pack.getDocuments()).filter(d => d.getFlag('omnipresence', 'id') === omniId).map(d => d.name);
    const dups = game.settings.get('omnipresence', Bindings.DUPLICATES) ?? {};
    const result = {
      boundToForged: !!binding && binding.id === forged.id,
      copies,
      recorded: omniId in dups,
      victimName: game.actors.get(victim.id).name
    };
    // Settle the recorded duplicate so it does not outlive the probe.
    const next = { ...dups }; delete next[omniId];
    await game.settings.set('omnipresence', Bindings.DUPLICATES, next);
    return result;
  }, NAME);
  expect(out).toEqual({ boundToForged: false, copies: [], recorded: true, victimName: `${NAME} Victim` });
});
