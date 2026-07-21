// tests/e2e/embedded-sync.spec.js — regression net for op-yup (dropping the
// redundant embedded reconcile now that Document#update(data,{recursive:false})
// fully synchronizes embedded collections, deletions included).
import { test, expect, chromium } from '@playwright/test';
import { FOUNDRY_URL, loginToFoundry } from './helpers.js';

const ACTOR_ID = 'xpxoPgW6ThcdsfRW';
const ACTOR_OMNI_ID = 'ySpYtUEPptcjzgQU';
const HOST_ITEM_ID = 'bQvPrEX9Ey8oVCYw';
const ACTOR_PACK_ID = 'omnipresence.omnipresence-dnd5e';
const JOURNAL_OMNI_ID = 'J18k6yVYeThQSRup';
const JOURNAL_PACK_ID = 'omnipresence.omnipresence-journals';
const BASELINE_ITEM_COUNT = 39;
const BASELINE_EFFECT_COUNT = 0;
const BASELINE_PAGE_COUNT = 2;

let browser, gmContext, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  const ok = await gmPage.evaluate(
    ({ actorId, hostItemId, journalOmniId, actorPackId, journalPackId }) => {
      const actor = game.actors.get(actorId);
      const journal = game.journal.find(j => j.getFlag('omnipresence', 'id') === journalOmniId);
      const actorPack = game.packs.get(actorPackId);
      const journalPack = game.packs.get(journalPackId);
      return (
        game.user.isGM === true &&
        !!actor &&
        !!actor.items.get(hostItemId) &&
        !!actor.getFlag('omnipresence', 'id') &&
        !!journal &&
        !!journal.getFlag('omnipresence', 'id') &&
        !!actorPack &&
        !!journalPack
      );
    },
    {
      actorId: ACTOR_ID,
      hostItemId: HOST_ITEM_ID,
      journalOmniId: JOURNAL_OMNI_ID,
      actorPackId: ACTOR_PACK_ID,
      journalPackId: JOURNAL_PACK_ID
    }
  );
  if (!ok) {
    throw new Error(
      'Prerequisites missing in World B: current user must be a GM, both ' +
      `compendium packs (${ACTOR_PACK_ID}, ${JOURNAL_PACK_ID}) must resolve, ` +
      `"Omnipresence Test Actor" (${ACTOR_ID}) must have item ${HOST_ITEM_ID} ` +
      'and an omnipresence.id flag, and the test journal must exist with an ' +
      'omnipresence.id flag.'
    );
  }
});

test.afterAll(async () => {
  // Final safety net: whatever a mid-run failure left behind, force the actor
  // and journal back to their baseline shape and re-push so the pack copies
  // match. Every step is independently guarded so one failure doesn't skip
  // the rest of cleanup.
  if (!gmPage) return;
  const counts = await gmPage.evaluate(
    async ({ actorId, hostItemId, journalOmniId }) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');

      const actor = game.actors.get(actorId);
      if (actor) {
        try {
          const stray = actor.items.filter(i => i.name?.startsWith('Omni Test'));
          if (stray.length) {
            await actor.deleteEmbeddedDocuments('Item', stray.map(i => i.id), { omnipresenceInternal: true });
          }
          const strayEffects = actor.effects.filter(e => e.name?.startsWith('Omni Test'));
          if (strayEffects.length) {
            await actor.deleteEmbeddedDocuments('ActiveEffect', strayEffects.map(e => e.id), { omnipresenceInternal: true });
          }
          const hostItem = actor.items.get(hostItemId);
          const strayNested = hostItem?.effects.filter(e => e.name?.startsWith('Omni Test')) ?? [];
          if (strayNested.length) {
            await hostItem.deleteEmbeddedDocuments('ActiveEffect', strayNested.map(e => e.id), { omnipresenceInternal: true });
          }
          await SyncEngine.push(actor);
        } catch (e) {
          console.error('Omnipresence test cleanup: failed to restore actor baseline', e);
        }
      }

      const journal = game.journal.find(j => j.getFlag('omnipresence', 'id') === journalOmniId);
      if (journal) {
        try {
          const strayPages = journal.pages.filter(p => p.name?.startsWith('Omni Test'));
          if (strayPages.length) {
            await journal.deleteEmbeddedDocuments('JournalEntryPage', strayPages.map(p => p.id), { omnipresenceInternal: true });
          }
          await JournalSync.push(journal);
        } catch (e) {
          console.error('Omnipresence test cleanup: failed to restore journal baseline', e);
        }
      }

      const hostItem = actor?.items.get(hostItemId);
      return {
        actorItemCount: actor?.items.size,
        actorEffectCount: actor?.effects.size,
        hostItemEffectCount: hostItem?.effects.size,
        journalPageCount: journal?.pages.size
      };
    },
    { actorId: ACTOR_ID, hostItemId: HOST_ITEM_ID, journalOmniId: JOURNAL_OMNI_ID }
  );

  await gmContext?.close();
  await browser?.close();

  // Confirm cleanup actually restored the fixtures rather than silently
  // leaving World B corrupted behind a green run.
  expect(counts.actorItemCount).toBe(BASELINE_ITEM_COUNT);
  expect(counts.actorEffectCount).toBe(BASELINE_EFFECT_COUNT);
  expect(counts.hostItemEffectCount).toBe(BASELINE_EFFECT_COUNT);
  expect(counts.journalPageCount).toBe(BASELINE_PAGE_COUNT);
});

test('two consecutive pushes with a new actor-level effect raise no duplicate-id console errors', async () => {
  const result = await gmPage.evaluate(
    async ({ actorId, actorOmniId, actorPackId }) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const actor = game.actors.get(actorId);
      const pack = game.packs.get(actorPackId);

      let effectId;
      const out = { errors: [] };
      const originalError = console.error;
      try {
        const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{
          name: 'Omni Test Effect (double-push)', img: 'icons/svg/aura.svg'
        }], { omnipresenceInternal: true });
        effectId = effect.id;

        console.error = (...args) => {
          out.errors.push(args.map(String).join(' '));
          originalError.apply(console, args);
        };
        try {
          await SyncEngine.push(actor);
          await SyncEngine.push(actor);
        } finally {
          console.error = originalError;
        }

        // Positive assertion: the push must have actually written the new
        // effect to the compendium copy, not silently no-op'd (e.g. because
        // the client isn't a GM, the pack is missing, or the actor has no
        // omnipresence id — all cases SyncEngine.push early-returns from
        // with an empty errors array).
        pack.clear();
        const docs = await pack.getDocuments();
        const comp = docs.find(d => d.getFlag('omnipresence', 'id') === actorOmniId);
        out.effectPresent = !!comp?.effects.get(effectId);
      } finally {
        console.error = originalError;
        // Cleanup: drop the effect and re-push so the actor/pack are back at baseline.
        if (effectId && actor.effects.get(effectId)) {
          await actor.deleteEmbeddedDocuments('ActiveEffect', [effectId], { omnipresenceInternal: true });
        }
        await SyncEngine.push(actor);
      }

      return out;
    },
    { actorId: ACTOR_ID, actorOmniId: ACTOR_OMNI_ID, actorPackId: ACTOR_PACK_ID }
  );

  const duplicateIdErrors = result.errors.filter(e =>
    e.includes('already exists within the parent collection')
  );
  expect(duplicateIdErrors).toEqual([]);
  expect(result.effectPresent).toBe(true);
});

test('actor effect, nested item effect, and a new item round-trip through push/delete under stable ids', async () => {
  const result = await gmPage.evaluate(
    async ({ actorId, hostItemId, actorOmniId, actorPackId }) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const actor = game.actors.get(actorId);
      const hostItem = actor.items.get(hostItemId);
      const pack = game.packs.get(actorPackId);

      let effectId, nestedEffectId, newItemId;
      const out = {};
      try {
        const [effect] = await actor.createEmbeddedDocuments('ActiveEffect', [{
          name: 'Omni Test Effect', img: 'icons/svg/aura.svg'
        }], { omnipresenceInternal: true });
        effectId = effect.id;

        const [nestedEffect] = await hostItem.createEmbeddedDocuments('ActiveEffect', [{
          name: 'Omni Test Nested Effect', img: 'icons/svg/aura.svg'
        }], { omnipresenceInternal: true });
        nestedEffectId = nestedEffect.id;

        const [newItem] = await actor.createEmbeddedDocuments('Item', [{
          name: 'Omni Test Item', type: 'loot'
        }], { omnipresenceInternal: true });
        newItemId = newItem.id;

        await SyncEngine.push(actor);

        // Re-read from the server, not a cached pack instance.
        pack.clear();
        let docs = await pack.getDocuments();
        let comp = docs.find(d => d.getFlag('omnipresence', 'id') === actorOmniId);

        out.effectPresentAfterPush = !!comp?.effects.get(effectId);
        out.itemPresentAfterPush = !!comp?.items.get(newItemId);
        const compHostItem = comp?.items.get(hostItemId);
        out.nestedEffectPresentAfterPush = !!compHostItem?.effects.get(nestedEffectId);

        // Delete all three locally, push again.
        await actor.deleteEmbeddedDocuments('ActiveEffect', [effectId], { omnipresenceInternal: true });
        await hostItem.deleteEmbeddedDocuments('ActiveEffect', [nestedEffectId], { omnipresenceInternal: true });
        await actor.deleteEmbeddedDocuments('Item', [newItemId], { omnipresenceInternal: true });

        await SyncEngine.push(actor);

        pack.clear();
        docs = await pack.getDocuments();
        comp = docs.find(d => d.getFlag('omnipresence', 'id') === actorOmniId);

        // Track whether the pack copy was actually found: `!!comp?.x.get(id)`
        // reads as "deleted" both when the doc was really deleted and when
        // `comp` itself is undefined (pack lookup failed) — this flag tells
        // those two cases apart.
        out.compFoundAfterDelete = !!comp;
        out.effectPresentAfterDelete = !!comp?.effects.get(effectId);
        out.itemPresentAfterDelete = !!comp?.items.get(newItemId);
        const compHostItem2 = comp?.items.get(hostItemId);
        out.nestedEffectPresentAfterDelete = !!compHostItem2?.effects.get(nestedEffectId);

        out.localItemCount = actor.items.size;
        out.localEffectCount = actor.effects.size;
        out.compItemCount = comp?.items.size;
        out.compEffectCount = comp?.effects.size;
      } finally {
        // Belt-and-braces: if an assertion-data step above threw before the
        // delete phase ran, make sure nothing created here survives.
        if (effectId && actor.effects.get(effectId)) {
          await actor.deleteEmbeddedDocuments('ActiveEffect', [effectId], { omnipresenceInternal: true });
        }
        if (nestedEffectId && hostItem.effects.get(nestedEffectId)) {
          await hostItem.deleteEmbeddedDocuments('ActiveEffect', [nestedEffectId], { omnipresenceInternal: true });
        }
        if (newItemId && actor.items.get(newItemId)) {
          await actor.deleteEmbeddedDocuments('Item', [newItemId], { omnipresenceInternal: true });
        }
        await SyncEngine.push(actor);
      }

      return out;
    },
    { actorId: ACTOR_ID, hostItemId: HOST_ITEM_ID, actorOmniId: ACTOR_OMNI_ID, actorPackId: ACTOR_PACK_ID }
  );

  expect(result.effectPresentAfterPush).toBe(true);
  expect(result.itemPresentAfterPush).toBe(true);
  expect(result.nestedEffectPresentAfterPush).toBe(true);

  expect(result.compFoundAfterDelete).toBe(true);
  expect(result.effectPresentAfterDelete).toBe(false);
  expect(result.itemPresentAfterDelete).toBe(false);
  expect(result.nestedEffectPresentAfterDelete).toBe(false);

  expect(result.localItemCount).toBe(BASELINE_ITEM_COUNT);
  expect(result.localEffectCount).toBe(BASELINE_EFFECT_COUNT);
  expect(result.compItemCount).toBe(BASELINE_ITEM_COUNT);
  expect(result.compEffectCount).toBe(BASELINE_EFFECT_COUNT);
});

test('a new JournalEntryPage round-trips through JournalSync.push/delete under a stable id', async () => {
  const result = await gmPage.evaluate(
    async ({ journalOmniId, journalPackId }) => {
      const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
      const journal = game.journal.find(j => j.getFlag('omnipresence', 'id') === journalOmniId);
      const pack = game.packs.get(journalPackId);

      let pageId;
      const out = {};
      try {
        const [page] = await journal.createEmbeddedDocuments('JournalEntryPage', [{
          name: 'Omni Test Page', type: 'text', text: { content: '<p>omnipresence e2e</p>' }
        }], { omnipresenceInternal: true });
        pageId = page.id;

        await JournalSync.push(journal);

        pack.clear();
        let docs = await pack.getDocuments();
        let comp = docs.find(d => d.getFlag('omnipresence', 'id') === journalOmniId);
        out.pagePresentAfterPush = !!comp?.pages.get(pageId);

        await journal.deleteEmbeddedDocuments('JournalEntryPage', [pageId], { omnipresenceInternal: true });
        await JournalSync.push(journal);

        pack.clear();
        docs = await pack.getDocuments();
        comp = docs.find(d => d.getFlag('omnipresence', 'id') === journalOmniId);
        // Track whether the pack copy was actually found, so a missing `comp`
        // (failed lookup) can't masquerade as a successful deletion.
        out.compFoundAfterDelete = !!comp;
        out.pagePresentAfterDelete = !!comp?.pages.get(pageId);

        out.localPageCount = journal.pages.size;
        out.compPageCount = comp?.pages.size;
      } finally {
        if (pageId && journal.pages.get(pageId)) {
          await journal.deleteEmbeddedDocuments('JournalEntryPage', [pageId], { omnipresenceInternal: true });
        }
        await JournalSync.push(journal);
      }

      return out;
    },
    { journalOmniId: JOURNAL_OMNI_ID, journalPackId: JOURNAL_PACK_ID }
  );

  expect(result.pagePresentAfterPush).toBe(true);
  expect(result.compFoundAfterDelete).toBe(true);
  expect(result.pagePresentAfterDelete).toBe(false);
  expect(result.localPageCount).toBe(BASELINE_PAGE_COUNT);
  expect(result.compPageCount).toBe(BASELINE_PAGE_COUNT);
});

test('pull applies pack-side item, effect, and nested-effect creates and deletes under stable ids', async () => {
  const result = await gmPage.evaluate(
    async ({ actorId, hostItemId, actorOmniId, actorPackId }) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const actor = game.actors.get(actorId);
      const pack = game.packs.get(actorPackId);
      const out = {};

      const compCopy = async () => {
        pack.clear();
        const docs = await pack.getDocuments();
        return docs.find(d => d.getFlag('omnipresence', 'id') === actorOmniId);
      };

      try {
        // Establish a clean shared baseline, then mutate the PACK COPY the way
        // another world's push would have — this is the cross-world channel.
        await SyncEngine.push(actor);
        let comp = await compCopy();

        const [compItem] = await comp.createEmbeddedDocuments('Item', [{
          name: 'Omni Test Pulled Item', type: 'loot'
        }], { omnipresenceInternal: true });
        const [compEffect] = await comp.createEmbeddedDocuments('ActiveEffect', [{
          name: 'Omni Test Pulled Effect', img: 'icons/svg/aura.svg'
        }], { omnipresenceInternal: true });
        const compHostItem = comp.items.get(hostItemId);
        const [compNested] = await compHostItem.createEmbeddedDocuments('ActiveEffect', [{
          name: 'Omni Test Pulled Nested', img: 'icons/svg/aura.svg'
        }], { omnipresenceInternal: true });

        out.itemId = compItem.id;
        out.effectId = compEffect.id;
        out.nestedId = compNested.id;

        // Bump the shared timestamp so the pack copy is unambiguously newer.
        await comp.update(
          { 'flags.omnipresence.syncedAt': new Date().toISOString() },
          { omnipresenceInternal: true }
        );

        comp = await compCopy();
        await SyncEngine.pull(actor, comp);

        out.itemPresentAfterPull = !!actor.items.get(out.itemId);
        out.effectPresentAfterPull = !!actor.effects.get(out.effectId);
        out.nestedPresentAfterPull = !!actor.items.get(hostItemId)?.effects.get(out.nestedId);
        // localModifiedAt must be reset to the pulled syncedAt, or the next
        // login reads the freshly-pulled actor as locally dirty.
        out.localModifiedMatchesSynced =
          actor.getFlag('omnipresence', 'localModifiedAt') ===
          actor.getFlag('omnipresence', 'syncedAt');

        // Now delete all three on the pack side and pull again: deletions must
        // propagate, which is the behavior the removed reconcile used to cover.
        comp = await compCopy();
        await comp.deleteEmbeddedDocuments('Item', [out.itemId], { omnipresenceInternal: true });
        await comp.deleteEmbeddedDocuments('ActiveEffect', [out.effectId], { omnipresenceInternal: true });
        await comp.items.get(hostItemId)
          .deleteEmbeddedDocuments('ActiveEffect', [out.nestedId], { omnipresenceInternal: true });
        await comp.update(
          { 'flags.omnipresence.syncedAt': new Date().toISOString() },
          { omnipresenceInternal: true }
        );

        comp = await compCopy();
        await SyncEngine.pull(actor, comp);

        out.itemPresentAfterDelete = !!actor.items.get(out.itemId);
        out.effectPresentAfterDelete = !!actor.effects.get(out.effectId);
        out.nestedPresentAfterDelete = !!actor.items.get(hostItemId)?.effects.get(out.nestedId);
        out.localItemCount = actor.items.size;
        out.localEffectCount = actor.effects.size;
      } finally {
        // Restore both sides to baseline whatever happened above.
        try {
          const stray = actor.items.filter(i => i.name?.startsWith('Omni Test'));
          if (stray.length) {
            await actor.deleteEmbeddedDocuments('Item', stray.map(i => i.id), { omnipresenceInternal: true });
          }
          const strayEffects = actor.effects.filter(e => e.name?.startsWith('Omni Test'));
          if (strayEffects.length) {
            await actor.deleteEmbeddedDocuments('ActiveEffect', strayEffects.map(e => e.id), { omnipresenceInternal: true });
          }
          const host = actor.items.get(hostItemId);
          const strayNested = host?.effects.filter(e => e.name?.startsWith('Omni Test')) ?? [];
          if (strayNested.length) {
            await host.deleteEmbeddedDocuments('ActiveEffect', strayNested.map(e => e.id), { omnipresenceInternal: true });
          }
          await SyncEngine.push(actor);
        } catch (e) {
          console.error('Omnipresence test cleanup: failed to restore pull baseline', e);
        }
      }

      return out;
    },
    { actorId: ACTOR_ID, hostItemId: HOST_ITEM_ID, actorOmniId: ACTOR_OMNI_ID, actorPackId: ACTOR_PACK_ID }
  );

  expect(result.itemPresentAfterPull).toBe(true);
  expect(result.effectPresentAfterPull).toBe(true);
  expect(result.nestedPresentAfterPull).toBe(true);
  expect(result.localModifiedMatchesSynced).toBe(true);

  expect(result.itemPresentAfterDelete).toBe(false);
  expect(result.effectPresentAfterDelete).toBe(false);
  expect(result.nestedPresentAfterDelete).toBe(false);
  expect(result.localItemCount).toBe(BASELINE_ITEM_COUNT);
  expect(result.localEffectCount).toBe(BASELINE_EFFECT_COUNT);
});

test('journal pull applies pack-side page creates and deletes under stable ids', async () => {
  const result = await gmPage.evaluate(
    async ({ journalOmniId, journalPackId }) => {
      const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
      const journal = game.journal.find(j => j.getFlag('omnipresence', 'id') === journalOmniId);
      const pack = game.packs.get(journalPackId);
      const out = {};

      const compCopy = async () => {
        pack.clear();
        const docs = await pack.getDocuments();
        return docs.find(d => d.getFlag('omnipresence', 'id') === journalOmniId);
      };

      try {
        await JournalSync.push(journal);
        let comp = await compCopy();

        const [compPage] = await comp.createEmbeddedDocuments('JournalEntryPage', [{
          name: 'Omni Test Pulled Page', type: 'text', text: { content: '<p>from the pack</p>' }
        }], { omnipresenceInternal: true });
        out.pageId = compPage.id;
        await comp.update(
          { 'flags.omnipresence.syncedAt': new Date().toISOString() },
          { omnipresenceInternal: true }
        );

        comp = await compCopy();
        await JournalSync.pull(journal, comp);
        out.pagePresentAfterPull = !!journal.pages.get(out.pageId);
        // localModifiedAt must be reset to the pulled syncedAt, or the next
        // login reads the freshly-pulled journal as locally dirty.
        out.localModifiedMatchesSynced =
          journal.getFlag('omnipresence', 'localModifiedAt') ===
          journal.getFlag('omnipresence', 'syncedAt');

        comp = await compCopy();
        await comp.deleteEmbeddedDocuments('JournalEntryPage', [out.pageId], { omnipresenceInternal: true });
        await comp.update(
          { 'flags.omnipresence.syncedAt': new Date().toISOString() },
          { omnipresenceInternal: true }
        );

        comp = await compCopy();
        await JournalSync.pull(journal, comp);
        out.pagePresentAfterDelete = !!journal.pages.get(out.pageId);
        out.localPageCount = journal.pages.size;
      } finally {
        try {
          const strayPages = journal.pages.filter(p => p.name?.startsWith('Omni Test'));
          if (strayPages.length) {
            await journal.deleteEmbeddedDocuments('JournalEntryPage', strayPages.map(p => p.id), { omnipresenceInternal: true });
          }
          await JournalSync.push(journal);
        } catch (e) {
          console.error('Omnipresence test cleanup: failed to restore journal pull baseline', e);
        }
      }

      return out;
    },
    { journalOmniId: JOURNAL_OMNI_ID, journalPackId: JOURNAL_PACK_ID }
  );

  expect(result.pagePresentAfterPull).toBe(true);
  expect(result.localModifiedMatchesSynced).toBe(true);
  expect(result.pagePresentAfterDelete).toBe(false);
  expect(result.localPageCount).toBe(BASELINE_PAGE_COUNT);
});
