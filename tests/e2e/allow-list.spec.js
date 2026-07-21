// tests/e2e/allow-list.spec.js — op-6rs: enroll and unenroll must move the
// doc's omnipresence id into and out of the OWNING user's per-world allow-list
// together. When they diverge, onLogin's auto-import (which resolves the pack
// copy's ownerName flag to a user and gates on THAT user's allow-list) re-
// imports the unenrolled doc as a duplicate.
//
// This specifically covers the cross-user case: a GM unenrolling another
// user's doc (every context-menu/dashboard unenroll path allows this). GMs
// have doc.isOwner === true on every document by role, so a naive fix that
// only clears the ACTING user's allow-list leaves the OWNING user's entry
// behind. The probe below is genuinely enrolled by its non-GM owner (a real
// second login, not just an `ownership` field) so the owner's own allow-list
// is populated exactly as it would be in the field, then unenrolled by the
// GM — the same shape as a GM using the dashboard to remove a player's actor.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

let browser, gmContext, ownerContext, gmPage, ownerPage, ownerName;

test.beforeAll(async () => {
  browser = await chromium.launch();

  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');

  const prereq = await gmPage.evaluate(async () => {
    const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
    const owner = game.users.find(u => !u.isGM);
    return {
      ok: game.user.isGM === true && !!game.packs.get(SyncEngine.PACK_ID) && !!owner,
      ownerName: owner?.name ?? null
    };
  });
  if (!prereq.ok) {
    throw new Error(
      'Prerequisites missing: the current user must be a GM, the actor ' +
      'compendium pack for the active system must resolve, and at least one ' +
      'non-GM user must exist in the world.'
    );
  }
  ownerName = prereq.ownerName;

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await loginToFoundry(ownerPage, ownerName);
});

test.afterAll(async () => {
  await gmContext?.close();
  await ownerContext?.close();
  await browser?.close();
});

test("GM unenrolling a player's doc clears the OWNING player's allow-list, not just the GM's", async () => {
  const out = {};
  let omniId;
  let ownerId;

  try {
    // 1. GM creates the probe, granting the non-GM user OWNER so `enroll`
    //    (run as that user below) resolves ownerName correctly.
    ownerId = await gmPage.evaluate(async (name) => {
      const owner = game.users.find(u => u.name === name);
      await Actor.create({
        name: 'Omni AllowList Probe',
        type: 'character',
        ownership: { default: 0, [owner.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
      });
      return owner.id;
    }, ownerName);

    // 2. Wait for the real-time create to reach the owner's own session, then
    //    have the OWNER enroll their own actor — this is what populates the
    //    owner's own allow-list, exactly as it would for a real player.
    await ownerPage.waitForFunction(
      () => !!game.actors.getName('Omni AllowList Probe'),
      { timeout: 10_000 }
    );
    const enrolled = await ownerPage.evaluate(async () => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const actor = game.actors.getName('Omni AllowList Probe');
      const id = await SyncRegistry.enroll(actor);
      return {
        id,
        ownerName: actor.getFlag('omnipresence', 'ownerName'),
        selectedAfterEnrollOwner: SyncRegistry.getSelection(game.user.id).actorIds.includes(id)
      };
    });
    omniId = enrolled.id;
    out.resolvedOwnerName = enrolled.ownerName;
    out.selectedAfterEnrollOwner = enrolled.selectedAfterEnrollOwner;

    // 3. GM pushes the actor to the shared compendium (push is GM-write-only;
    //    a non-GM caller would no-op).
    await gmPage.evaluate(async () => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      const actor = game.actors.getName('Omni AllowList Probe');
      await SyncEngine.push(actor);
    });

    // 4. GM unenrolls the actor — acting as the GM, on a document they do not
    //    own in practice, the cross-user case Finding 1 targets.
    const afterUnenroll = await gmPage.evaluate(async () => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      const actor = game.actors.getName('Omni AllowList Probe');
      const id = actor.getFlag('omnipresence', 'id');
      await SyncRegistry.unenroll(actor);
      return {
        selectedAfterUnenrollGM: SyncRegistry.getSelection(game.user.id).actorIds.includes(id),
        stillUnenrolled: !SyncRegistry.isEnrolled(actor)
      };
    });
    out.selectedAfterUnenrollGM = afterUnenroll.selectedAfterUnenrollGM;
    out.stillUnenrolled = afterUnenroll.stillUnenrolled;

    // The assertion with teeth: the OWNING (non-GM) user's own allow-list,
    // read from the owner's own session, must also have lost the id.
    out.selectedAfterUnenrollOwner = await ownerPage.evaluate(async (id) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      return SyncRegistry.getSelection(game.user.id).actorIds.includes(id);
    }, omniId);

    // 5. The defect surfaces here: onLogin's auto-import resolves ownerName to
    // the owning (non-GM) user and gates on THAT user's allow-list. If the
    // owner's entry survived unenroll, the doc gets re-imported as a
    // duplicate even though the GM's own list was already clean.
    out.copiesAfterLogin = await gmPage.evaluate(async (id) => {
      const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
      await SyncEngine.onLogin();
      return game.actors.filter(a => a.getFlag('omnipresence', 'id') === id).length;
    }, omniId);
  } finally {
    // Remove every copy of the probe and its pack entry, plus any allow-list
    // residue on BOTH the GM's and the owning user's lists, so a mid-run
    // failure cannot leak fixtures into the world.
    await gmPage.evaluate(async () => {
      for (const a of game.actors.filter(a => a.name === 'Omni AllowList Probe')) {
        try { await a.delete(); } catch (e) { console.error('probe cleanup: actor', e); }
      }
    });
    try {
      if (omniId) {
        await gmPage.evaluate(async (id) => {
          const { SyncEngine } = await import('/modules/omnipresence/scripts/sync-engine.js');
          const pack = game.packs.get(SyncEngine.PACK_ID);
          pack.clear();
          const comp = (await pack.getDocuments()).find(
            d => d.getFlag('omnipresence', 'id') === id
          );
          await comp?.delete();
        }, omniId);
      }
    } catch (e) { console.error('probe cleanup: pack copy', e); }
    try {
      if (omniId) {
        await gmPage.evaluate(async ({ id, ownerId }) => {
          const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
          await SyncRegistry.removeFromSelection(game.user.id, 'actor', id);
          if (ownerId) await SyncRegistry.removeFromSelection(ownerId, 'actor', id);
        }, { id: omniId, ownerId });
      }
    } catch (e) { console.error('probe cleanup: allow-list', e); }
  }

  expect(out.resolvedOwnerName).toBe(ownerName);
  expect(out.selectedAfterEnrollOwner).toBe(true);
  expect(out.selectedAfterUnenrollGM).toBe(false);
  expect(out.selectedAfterUnenrollOwner).toBe(false);
  expect(out.stillUnenrolled).toBe(true);
  expect(out.copiesAfterLogin).toBe(1);
});

test('the Manage synced documents button opens the picker seeded from the stored allow-list', async () => {
  // Force a genuine gap between the stored allow-list and the candidate
  // list before opening the picker. enroll() auto-adds to the acting user's
  // own selection, so the GM's live allow-list can easily already contain
  // every visible candidate — in which case even a picker that ignores
  // `preselected` and defaults to all-checked would make every assertion
  // below pass by accident. Removing one id we know was selected guarantees
  // at least one candidate is NOT selected, so the test can only pass if
  // that specific checkbox is genuinely wired to the stored value.
  //
  // The stored allow-list can accumulate orphan ids over time: enroll()
  // unconditionally appends auto-imported actors to the acting GM's
  // selection during onLogin's auto-import, including actors owned by other
  // users. So `actorIds[0]` is not guaranteed to correspond to a rendered
  // candidate — its document may be deleted locally, or its pack copy may
  // resolve to a different ownerName. Removing such a stale id would still
  // leave every rendered box matching its true membership, so
  // `removedBoxFound` would fail for an unrelated reason. Enumerate the same
  // candidate set the picker renders from (DocPicker._buildCandidates, the
  // function `_renderContent` turns into `input[data-kind]` rows) and only
  // pick an id that is CONFIRMED to be in it.
  const gap = await gmPage.evaluate(async () => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { DocPicker } = await import('/modules/omnipresence/scripts/doc-picker.js');
    const sel = SyncRegistry.getSelection(game.user.id);
    const candidates = await DocPicker._buildCandidates();
    const actorCandidateIds = new Set(candidates.actors.map(c => c.id));
    const journalCandidateIds = new Set(candidates.journals.map(c => c.id));
    const actorHit = sel.actorIds.find(id => actorCandidateIds.has(id));
    const journalHit = sel.journalIds.find(id => journalCandidateIds.has(id));
    if (actorHit) return { kind: 'actor', id: actorHit };
    if (journalHit) return { kind: 'journal', id: journalHit };
    return null;
  });
  if (!gap) {
    throw new Error(
      "No id in the GM's stored allow-list corresponds to a rendered " +
      'picker candidate — the test needs at least one confirmed-rendered ' +
      'id to construct a discriminating gap.'
    );
  }

  const removed = await gmPage.evaluate(async ({ kind, id }) => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    await SyncRegistry.removeFromSelection(game.user.id, kind, id);
    return { kind, id };
  }, gap);

  try {
    await gmPage.evaluate(() => game.user.sheet.render(true));
    await gmPage.waitForFunction(
      () => !!document.querySelector('#omnipresence-manage-docs'),
      { timeout: 5_000 }
    );

    await gmPage.click('#omnipresence-manage-docs');
    await gmPage.waitForFunction(
      () => !!document.querySelector('[data-list="actor"], [data-list="journal"]'),
      { timeout: 5_000 }
    );

    const seeded = await gmPage.evaluate((removedId) => {
      const selection = game.user.getFlag('omnipresence', 'selection') ?? {};
      const allowed = new Set([...(selection.actorIds ?? []), ...(selection.journalIds ?? [])]);
      const boxes = [...document.querySelectorAll('input[data-kind]')];
      const removedBox = boxes.find(b => b.value === removedId);
      return {
        boxCount: boxes.length,
        removedBoxFound: !!removedBox,
        removedBoxChecked: removedBox ? removedBox.checked : null,
        // Every rendered box's checked state must match the stored allow-list —
        // including the deliberately-removed one, which must now render
        // unchecked, and every other box, which must still match its true
        // membership (i.e. still render checked where it's still selected).
        mismatches: boxes
          .filter(b => b.checked !== allowed.has(b.value))
          .map(b => b.value)
      };
    }, removed.id);

    // Close via the dialog's header button so nothing is saved.
    await gmPage.evaluate(() => {
      const dialog = [...foundry.applications.instances.values()]
        .find(a => a.constructor.name === 'DialogV2');
      dialog?.close();
      game.user.sheet.close();
    });

    expect(seeded.boxCount).toBeGreaterThan(0);
    expect(seeded.removedBoxFound).toBe(true);
    expect(seeded.removedBoxChecked).toBe(false);
    expect(seeded.mismatches).toEqual([]);
  } finally {
    // Restore exactly what was removed so the GM's allow-list is left as found.
    await gmPage.evaluate(async ({ kind, id }) => {
      const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
      await SyncRegistry.addToSelection(game.user.id, kind, id);
    }, removed);
  }
});

test('filtering hides non-matching rows and All/None acts only on visible rows', async () => {
  await gmPage.evaluate(() => game.user.sheet.render(true));
  await gmPage.waitForFunction(
    () => !!document.querySelector('#omnipresence-manage-docs'),
    { timeout: 5_000 }
  );
  await gmPage.click('#omnipresence-manage-docs');
  await gmPage.waitForFunction(
    () => !!document.querySelector('[data-list="actor"]'),
    { timeout: 5_000 }
  );

  const result = await gmPage.evaluate(async () => {
    const list = document.querySelector('[data-list="actor"]');
    const rows = [...list.querySelectorAll('[data-row]')];
    const filterInput = document.querySelector('[data-filter="actor"]');
    const noneButton = document.querySelector('[data-bulk="none"][data-kind="actor"]');

    // Filter to exactly one row by using a full name as the query.
    const targetName = rows[0].dataset.name;
    const targetId = rows[0].dataset.id;
    for (const row of rows) row.querySelector('input').checked = true;

    filterInput.value = targetName;
    filterInput.dispatchEvent(new Event('input', { bubbles: true }));

    const visible = rows.filter(r => r.style.display !== 'none');
    const out = {
      totalRows: rows.length,
      visibleAfterFilter: visible.length,
      visibleIncludesTarget: visible.some(r => r.dataset.id === targetId),
      counterText: document.querySelector('[data-counter="actor"]').textContent
    };

    // None must clear only the visible rows, leaving filtered-out rows checked.
    noneButton.click();
    out.targetCheckedAfterNone = rows.find(r => r.dataset.id === targetId)
      .querySelector('input').checked;
    out.hiddenStillChecked = rows
      .filter(r => r.style.display === 'none')
      .every(r => r.querySelector('input').checked);

    return out;
  });

  // Close without saving.
  await gmPage.evaluate(() => {
    const dialog = [...foundry.applications.instances.values()]
      .find(a => a.constructor.name === 'DialogV2');
    dialog?.close();
    game.user.sheet.close();
  });

  expect(result.visibleAfterFilter).toBeGreaterThanOrEqual(1);
  expect(result.visibleIncludesTarget).toBe(true);
  expect(result.counterText).toContain(String(result.totalRows));
  expect(result.targetCheckedAfterNone).toBe(false);
  expect(result.hiddenStillChecked).toBe(true);
});

test('saving the manage dialog writes the allow-list and leaves the local document untouched', async () => {
  const result = await gmPage.evaluate(async () => {
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const { DocPicker } = await import('/modules/omnipresence/scripts/doc-picker.js');

    const actor = await Actor.create({ name: 'Omni Manage Probe', type: 'character' });
    const out = {};
    let omniId;
    try {
      omniId = await SyncRegistry.enroll(actor);
      const before = SyncRegistry.getSelection(game.user.id);
      out.selectedBefore = before.actorIds.includes(omniId);

      // Drive the dialog: open it, uncheck the probe, confirm.
      const pending = DocPicker.open({ mode: 'manage', preselected: before });
      await new Promise(r => setTimeout(r, 500)); // let DialogV2 render
      const box = document.querySelector(`input[data-kind="actor"][value="${omniId}"]`);
      out.boxFound = !!box;
      if (box) box.checked = false;
      document.querySelector('button[data-action="confirm"]').click();
      const picked = await pending;

      out.pickedExcludesProbe = !picked.actorIds.includes(omniId);

      await SyncRegistry.setSelection(game.user.id, {
        actorIds: picked.actorIds,
        journalIds: picked.journalIds
      });

      out.selectedAfter = SyncRegistry.getSelection(game.user.id).actorIds.includes(omniId);
      // Unchecking is a gate change only — the doc stays enrolled and present.
      out.stillEnrolled = SyncRegistry.isEnrolled(actor);
      out.stillPresent = !!game.actors.get(actor.id);
    } finally {
      for (const a of game.actors.filter(a => a.name === 'Omni Manage Probe')) {
        try { await a.delete(); } catch (e) { console.error('manage probe cleanup: actor', e); }
      }
      try {
        if (omniId) await SyncRegistry.removeFromSelection(game.user.id, 'actor', omniId);
      } catch (e) { console.error('manage probe cleanup: allow-list', e); }
    }
    return out;
  });

  expect(result.boxFound).toBe(true);
  expect(result.selectedBefore).toBe(true);
  expect(result.pickedExcludesProbe).toBe(true);
  expect(result.selectedAfter).toBe(false);
  expect(result.stillEnrolled).toBe(true);
  expect(result.stillPresent).toBe(true);
});
