// tests/e2e/sync-followups-2.spec.js — round-2 follow-ups (op-52t, op-67y, op-5a2)
import { test, expect, chromium } from '@playwright/test';

const FOUNDRY_URL = 'http://localhost:30000';

let browser, gmContext, gmPage;

async function loginToFoundry(page, userName) {
  await page.goto(`${FOUNDRY_URL}/join`);
  await page.waitForFunction(
    (name) => {
      const sel = document.querySelector('select[name="userid"]');
      return [...(sel?.options ?? [])].some(o => o.text === name);
    },
    userName,
    { timeout: 15_000 }
  );
  // The option may be marked disabled if another automation session is already
  // connected as this user — benign on this shared dev server; Foundry accepts
  // the login, only the stale client-side attribute needs bypassing.
  await page.evaluate((name) => {
    const sel = document.querySelector('select[name="userid"]');
    const opt = [...sel.options].find(o => o.text === name);
    opt.disabled = false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, userName);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.game?.ready === true, { timeout: 30_000 });
}

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  const ok = await gmPage.evaluate(() =>
    !!game.journal.getName('Omnipresence Test Journal') && game.scenes.size > 0
  );
  if (!ok) throw new Error('Prerequisites missing in World A (test journal / a scene).');
});

test.afterAll(async () => {
  await gmContext?.close();
  await browser?.close();
});

test('pull right after push produces no spurious page updates (_stats stripped)', async () => {
  const count = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const omniId = journal.getFlag('omnipresence', 'id');

    await JournalSync.push(journal);
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);

    // Content is identical post-push; only server-managed _stats differ. A
    // clean reconcile must therefore issue zero page updates.
    let updates = 0;
    const hookId = Hooks.on('updateJournalEntryPage', () => updates++);
    await JournalSync.pull(journal, comp);
    Hooks.off('updateJournalEntryPage', hookId);

    // Restore push-authoritative local state (pull reset localModifiedAt).
    await JournalSync.push(journal);
    return updates;
  });
  expect(count).toBe(0);
});

test('applyAllPins does not mirror pins onto a journal in unresolved conflict (B1 gate)', async () => {
  const result = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const omniId = journal.getFlag('omnipresence', 'id');
    const scene = game.scenes.contents[0];
    const pack = game.packs.get('omnipresence.omnipresence-journals');

    // Baseline: in-sync pack copy.
    await JournalSync.push(journal);
    let comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);

    // A local pin the pack payload does not contain.
    const [note] = await scene.createEmbeddedDocuments('Note', [{
      entryId: journal.id, x: 1500, y: 1500
    }], { omnipresenceInternal: true });

    let conflictArmed, pinSurvived;
    try {
      // Force a conflict: dirty local (localModifiedAt > syncedAt) AND newer
      // pack copy (comp syncedAt > local syncedAt), with an empty pin payload
      // that WOULD mirror-delete the local pin if the gate failed.
      // syncedAt is an ISO date string, so timestamp math must go through
      // getTime()/toISOString() — plain `syncedAt + 1000` string-concatenates
      // instead of adding, producing an Invalid Date that silently defeats the
      // conflict arithmetic below.
      const syncedAt = journal.getFlag('omnipresence', 'syncedAt');
      const syncedAtMs = new Date(syncedAt).getTime();
      const localModifiedAt = new Date(syncedAtMs + 1000).toISOString();
      const compSyncedAt = new Date(syncedAtMs + 2000).toISOString();
      await journal.update(
        { 'flags.omnipresence.localModifiedAt': localModifiedAt },
        { omnipresenceInternal: true }
      );
      await comp.update({
        'flags.omnipresence.syncedAt': compSyncedAt,
        'flags.omnipresence.pins': []
      });
      // Read back through a fresh pack fetch — guards against stale-cache reads.
      comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
      conflictArmed = comp.getFlag('omnipresence', 'syncedAt') === compSyncedAt;

      await JournalSync.applyAllPins();
      pinSurvived = scene.notes.some(n => n.id === note.id);
    } finally {
      // Cleanup: drop the pin, resolve the conflict by pushing local state.
      // Runs even if an assertion-data step above threw.
      await scene.deleteEmbeddedDocuments('Note', [note.id], { omnipresenceInternal: true });
      await JournalSync.push(journal);
    }

    return { conflictArmed, pinSurvived };
  });
  expect(result.conflictArmed).toBe(true);
  expect(result.pinSurvived).toBe(true);
});

test('quoted fromUuid ids in macro commands are canonicalized on push', async () => {
  const result = await gmPage.evaluate(async () => {
    const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const journalOmni = journal.getFlag('omnipresence', 'id');

    const macro = await Macro.create({
      name: 'OmniFromUuid Test Macro',
      type: 'script',
      command: `const j = await fromUuid('JournalEntry.${journal.id}'); console.log(j?.name);`
    });

    // Capture whatever slot 9 held before this test so cleanup can restore
    // it exactly, instead of clobbering it with a dangling null-valued key.
    const prevSlot9 = game.user.hotbar[9];
    let canonical = '';
    let comp;
    try {
      await game.user.update({ hotbar: { ...game.user.hotbar, 9: macro.id } }, { omnipresenceInternal: true });
      await MacroSync.pushForUser(game.user);

      const pack = game.packs.get('omnipresence.omnipresence-macros');
      const ompId = macro.getFlag('omnipresence', 'id');
      comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === ompId);
      canonical = comp?._source?.command ?? '';
    } finally {
      // Restore slot 9 (or remove the key entirely if it was previously
      // unset), then delete the macro and pack copy. Each step is guarded
      // so a partial failure doesn't skip the rest of cleanup.
      try {
        if (prevSlot9 !== undefined) {
          await game.user.update({ hotbar: { ...game.user.hotbar, 9: prevSlot9 } }, { omnipresenceInternal: true });
        } else {
          await game.user.update({ 'hotbar.-=9': null }, { omnipresenceInternal: true });
        }
      } catch (e) {
        console.error('Omnipresence test cleanup: failed to restore hotbar slot 9', e);
      }
      try {
        await comp?.delete();
      } catch (e) {
        console.error('Omnipresence test cleanup: failed to delete pack copy', e);
      }
      try {
        await macro.delete();
      } catch (e) {
        console.error('Omnipresence test cleanup: failed to delete macro', e);
      }
    }

    return { canonical, journalOmni, journalLocalId: journal.id };
  });
  expect(result.canonical).toContain(`fromUuid('JournalEntry.${result.journalOmni}')`);
  expect(result.canonical).not.toContain(result.journalLocalId);
});
