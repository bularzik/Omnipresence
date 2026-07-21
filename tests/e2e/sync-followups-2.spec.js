// tests/e2e/sync-followups-2.spec.js — round-2 follow-ups (op-52t, op-67y, op-5a2)
import { test, expect, chromium } from '@playwright/test';
import { FOUNDRY_URL, loginToFoundry } from './helpers.js';

let browser, gmContext, gmPage, playerContext, playerPage, playerName;

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  const prereq = await gmPage.evaluate(() => ({
    ok: !!game.journal.getName('Omnipresence Test Journal') && game.scenes.size > 0,
    playerName: game.users.find(u => !u.isGM)?.name ?? null
  }));
  if (!prereq.ok) throw new Error('Prerequisites missing in World B (test journal / a scene).');
  if (!prereq.playerName) {
    throw new Error('Prerequisites missing: at least one non-GM user must exist in the world.');
  }
  playerName = prereq.playerName;

  // Second context: a real non-GM login, needed only by the macro pull test
  // below (MacroSync.onLogin()'s GM push phase runs before its pull phase in
  // the same call, so only a non-GM session exercises pull in isolation).
  playerContext = await browser.newContext();
  playerPage = await playerContext.newPage();
  await loginToFoundry(playerPage, playerName);
});

test.afterAll(async () => {
  await gmContext?.close();
  await playerContext?.close();
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

test('quoted fromUuid ids in macro commands are localized on pull', async () => {
  // MacroSync.onLogin() runs a GM push phase before its pull phase in the
  // same call (macro-sync.js:130-141). As GM, that push would immediately
  // overwrite — or, per op-bhm, delete — the pack copy this test sets up. A
  // non-GM session skips the push phase entirely and runs only the pull
  // (macro-sync.js:130's `if (game.user.isGM)` guard), so the player page is
  // what actually drives the assertion below.
  const out = {};
  let playerId, ompId, prevSlot9, hadPrevSlot9;

  try {
    // --- GM setup -----------------------------------------------------
    const setup = await gmPage.evaluate(async (playerName) => {
      const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
      const journal = game.journal.getName('Omnipresence Test Journal');
      const journalOmni = journal.getFlag('omnipresence', 'id');
      const journalLocalId = journal.id;
      const playerUser = game.users.find(u => u.name === playerName);

      const macro = await Macro.create({
        name: 'OmniFromUuid Pull Macro',
        type: 'script',
        command: `const j = await fromUuid('JournalEntry.${journalLocalId}'); console.log(j?.name);`,
        ownership: { default: 0, [playerUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
      });

      // Capture whatever slot 9 held before this test so cleanup can restore
      // it exactly, instead of clobbering it with a dangling null-valued key.
      const prevSlot9 = playerUser.hotbar[9];
      await playerUser.update(
        { hotbar: { ...playerUser.hotbar, 9: macro.id } },
        { omnipresenceInternal: true }
      );
      // Push-side precondition: produces the pack copy with ownerName set to
      // the player, hotbarSlots: [9], and a canonicalized command.
      await MacroSync.pushForUser(playerUser);

      const pack = game.packs.get(MacroSync.PACK_ID);
      const ompId = macro.getFlag('omnipresence', 'id');
      const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === ompId);
      const canonical = comp?._source?.command ?? '';

      // The trick that makes this a real test: overwrite the LOCAL macro's
      // command so it carries the CANONICAL id instead of the local one —
      // the exact state a genuine localizing pull must correct. A pull that
      // merely leaves an already-present local macro untouched (e.g. a
      // silently no-op localize, or an update call that never fires) would
      // leave this canonical id in place and fail the assertions below.
      await macro.update({ command: canonical }, { omnipresenceInternal: true });

      return {
        ompId,
        canonical,
        journalOmni,
        journalLocalId,
        playerId: playerUser.id,
        prevSlot9: prevSlot9 ?? null,
        hadPrevSlot9: prevSlot9 !== undefined
      };
    }, playerName);

    Object.assign(out, setup);
    playerId = setup.playerId;
    ompId = setup.ompId;
    prevSlot9 = setup.prevSlot9;
    hadPrevSlot9 = setup.hadPrevSlot9;

    // Push-side precondition: if this fails, setup — not the module under
    // test — is broken.
    expect(out.canonical).toContain(`fromUuid('JournalEntry.${out.journalOmni}')`);

    // --- non-GM pull ----------------------------------------------------
    // Wait for the player's own session to observe (via real-time doc sync)
    // the macro carrying the canonical command and its omnipresence id flag,
    // so onLogin's pull deterministically takes the UPDATE path — an
    // existing local macro with a matching id — rather than racing ahead of
    // the sync and taking the create path instead.
    await playerPage.waitForFunction(
      ({ ompId, canonical }) => {
        const m = game.macros.find(mm => mm.getFlag('omnipresence', 'id') === ompId);
        return !!m && m._source.command === canonical;
      },
      { ompId, canonical: out.canonical },
      { timeout: 10_000 }
    );

    out.pulled = await playerPage.evaluate(async (id) => {
      const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
      await MacroSync.onLogin();
      const macro = game.macros.find(m => m.getFlag('omnipresence', 'id') === id);
      return macro?._source?.command ?? '';
    }, ompId);
  } finally {
    // Everything below is undone independently, each step guarded so one
    // failure cannot skip the rest.
    try {
      await gmPage.evaluate(async ({ playerId, prevSlot9, hadPrevSlot9 }) => {
        const playerUser = game.users.get(playerId);
        if (!playerUser) return;
        if (hadPrevSlot9) {
          await playerUser.update(
            { hotbar: { ...playerUser.hotbar, 9: prevSlot9 } },
            { omnipresenceInternal: true }
          );
        } else {
          await playerUser.update({ 'hotbar.-=9': null }, { omnipresenceInternal: true });
        }
      }, { playerId, prevSlot9, hadPrevSlot9 });
    } catch (e) {
      console.error('Omnipresence test cleanup: failed to restore hotbar slot 9', e);
    }
    try {
      await gmPage.evaluate(async (id) => {
        const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
        const pack = game.packs.get(MacroSync.PACK_ID);
        pack.clear();
        const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === id);
        await comp?.delete();
      }, ompId);
    } catch (e) {
      console.error('Omnipresence test cleanup: failed to delete pack copy', e);
    }
    try {
      // Delete by NAME, not a captured id — ids can change across a pull.
      await gmPage.evaluate(async () => {
        for (const m of game.macros.filter(m => m.name === 'OmniFromUuid Pull Macro')) {
          await m.delete();
        }
      });
    } catch (e) {
      console.error('Omnipresence test cleanup: failed to delete macro', e);
    }
  }

  // Push side: the pack copy carries the canonical omnipresence id.
  expect(out.journalLocalId).not.toBe(out.journalOmni);
  expect(out.canonical).toContain(`fromUuid('JournalEntry.${out.journalOmni}')`);
  // Pull side (the gap op-5fh names): the re-imported macro carries this
  // world's local id again, and no canonical id leaks into world content.
  expect(out.pulled).toContain(`fromUuid('JournalEntry.${out.journalLocalId}')`);
  expect(out.pulled).not.toContain(out.journalOmni);
});
