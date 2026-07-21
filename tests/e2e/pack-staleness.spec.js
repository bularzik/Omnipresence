// tests/e2e/pack-staleness.spec.js — op-oh6. Two GM-capable clients each hold
// their own CompendiumCollection instance. If compendium writes do not
// broadcast, client B's cached pack documents go stale after client A pushes,
// and B's decideSyncAction reads a stale compSyncedAt. This spec settles
// whether that is real; it stays as a regression guard either way.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

let browser, contextA, contextB, pageA, pageB;

test.beforeAll(async () => {
  browser = await chromium.launch();
  // Two independent browser contexts, both logged in as the GM. The shared
  // helper force-clears the disabled <option> attribute Foundry sets while
  // another client holds that user, which is exactly this situation.
  contextA = await browser.newContext();
  pageA = await contextA.newPage();
  await loginToFoundry(pageA, 'Gamemaster');

  contextB = await browser.newContext();
  pageB = await contextB.newPage();
  await loginToFoundry(pageB, 'Gamemaster');

  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    const ok = await page.evaluate(async () => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      return game.user.isGM === true && !!game.packs.get(SyncEngine.PACK_ID);
    });
    if (!ok) {
      throw new Error(
        `Prerequisites missing on client ${label}: the user must be a GM and ` +
        'the actor compendium pack for the active system must resolve.'
      );
    }
  }
});

test.afterAll(async () => {
  await contextA?.close();
  await contextB?.close();
  await browser?.close();
});

test('a compendium write by client A is visible to client B without an explicit pack.clear()', async () => {
  const out = {};
  let omniId;

  try {
    // A: create and enroll a probe actor, push it, and hand B its id.
    omniId = await pageA.evaluate(async () => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const actor = await Actor.create({ name: 'Omni Staleness Probe', type: 'character' });
      const id = await SyncRegistry.enroll(actor);
      await SyncEngine.push(actor);
      return id;
    });

    // B: warm its own pack instance by reading the probe once.
    out.warmed = await pageB.evaluate(async (id) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const pack = game.packs.get(SyncEngine.PACK_ID);
      const docs = await pack.getDocuments();
      return docs.find(d => d.getFlag('omnipresence', 'id') === id)?.name ?? null;
    }, omniId);

    // A: rename and push again.
    await pageA.evaluate(async (id) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const actor = game.actors.find(a => a.getFlag('omnipresence', 'id') === id);
      await actor.update({ name: 'Omni Staleness Probe Renamed' }, { omnipresenceInternal: true });
      await SyncEngine.push(actor);
    }, omniId);

    // B: re-read WITHOUT pack.clear(). This is the assertion under test.
    out.seenByB = await pageB.evaluate(async (id) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const pack = game.packs.get(SyncEngine.PACK_ID);
      const docs = await pack.getDocuments();
      const doc = docs.find(d => d.getFlag('omnipresence', 'id') === id);
      return { name: doc?.name ?? null, syncedAt: doc?.getFlag('omnipresence', 'syncedAt') ?? null };
    }, omniId);
  } finally {
    // Remove the probe actor and its pack copy, guarded independently, so a
    // mid-run failure (a failed enroll, a network hiccup, or the `warmed`/
    // `seenByB` assertions themselves catching a real staleness regression)
    // cannot leak fixtures into the world every later spec runs against.
    // Deleted by NAME, never gated on omniId: the create/enroll/push evaluate
    // below can throw after Actor.create succeeds, leaving a probe behind with
    // omniId never assigned.
    try {
      await pageA.evaluate(async () => {
        for (const a of game.actors.filter(a => a.name === 'Omni Staleness Probe' || a.name === 'Omni Staleness Probe Renamed')) {
          try { await a.delete(); } catch (e) { console.error('staleness cleanup: actor', e); }
        }
      });
    } catch (e) { console.error('staleness cleanup: actor evaluate', e); }
    try {
      if (omniId) {
        await pageA.evaluate(async (id) => {
          const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
          const pack = game.packs.get(SyncEngine.PACK_ID);
          pack.clear();
          const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === id);
          await comp?.delete();
        }, omniId);
      }
    } catch (e) { console.error('staleness cleanup: pack copy', e); }
  }

  // Assertions run after cleanup, so a failure here still leaves the world
  // clean.
  expect(out.warmed).toBe('Omni Staleness Probe');
  expect(out.seenByB.name).toBe('Omni Staleness Probe Renamed');
  expect(out.seenByB.syncedAt).not.toBeNull();
});
