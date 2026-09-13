// tests/e2e/delete-reimport.spec.js — op-74f: deleting an enrolled document is
// NOT an unenroll. The pack copy stays and the document comes back at the next
// login reconcile (README, Notes). The delete hook used to call unenroll, which
// silently rejected on the already-deleted document; this pins the contract
// now that the call is gone.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

const NAME = 'Omni Reimport Probe';
let browser, ctx, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  ctx = await browser.newContext();
  gmPage = await ctx.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
});

test.afterAll(async () => {
  await gmPage?.evaluate(async ({ NAME }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    for (const a of game.actors.filter(a => a.name === NAME)) { await SyncRegistry.unenroll(a); await a.delete(); }
    const pack = game.packs.get(SyncEngine.PACK_ID);
    for (const d of await pack.getDocuments()) if (d.name === NAME) await d.delete();
  }, { NAME }).catch(() => {});
  await ctx?.close();
  await browser?.close();
});

test('a deleted enrolled actor keeps its pack copy and is re-imported at the next login reconcile', async () => {
  const out = await gmPage.evaluate(async ({ NAME }) => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const pack = game.packs.get(SyncEngine.PACK_ID);
    const actor = await Actor.create({ name: NAME, type: 'character' });
    const omniId = await SyncRegistry.enroll(actor);
    await SyncEngine.push(actor);
    await actor.delete();
    await new Promise(r => setTimeout(r, 500));
    pack.clear();
    const packAfterDelete = (await pack.getDocuments()).some(d => d.getFlag('omnipresence', 'id') === omniId);
    const selectedAfterDelete = SyncRegistry.isDocSelected(game.user.id, 'actor', omniId);
    await SyncEngine.onLogin();
    const back = game.actors.find(a => a.getFlag('omnipresence', 'id') === omniId);
    return { packAfterDelete, selectedAfterDelete, reimported: !!back, name: back?.name, enrolled: back ? SyncRegistry.isEnrolled(back) : null };
  }, { NAME });
  expect(out.packAfterDelete).toBe(true);
  expect(out.selectedAfterDelete).toBe(true);
  expect(out.reimported).toBe(true);
  expect(out.name).toBe(NAME);
  expect(out.enrolled).toBe(true);
});
