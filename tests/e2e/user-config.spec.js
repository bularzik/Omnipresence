// tests/e2e/user-config.spec.js
import { test, expect, chromium } from '@playwright/test';
import { FOUNDRY_URL, loginToFoundry } from './helpers.js';

const DEBOUNCE_WAIT_MS = 4_000;

let browser, gmContext, userContext, gmPage, userPage;

test.beforeAll(async () => {
  browser = await chromium.launch();

  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');

  userContext = await browser.newContext();
  userPage = await userContext.newPage();
  await loginToFoundry(userPage, 'User 1');

  const actorExists = await userPage.evaluate(() =>
    !!game.actors.getName('Omnipresence Test Actor')
  );
  if (!actorExists) {
    throw new Error(
      'Prerequisite missing: "Omnipresence Test Actor" not found in World A. ' +
      'Create the actor, grant User 1 OWNER permission, and enroll via context menu.'
    );
  }

  const hasHotbarMacro = await userPage.evaluate(() => !!game.user.hotbar[1]);
  if (!hasHotbarMacro) {
    throw new Error(
      'Prerequisite missing: User 1 has no macro in hotbar slot 1. ' +
      'Add any macro to slot 1 and verify it appears in the macro compendium.'
    );
  }
});

test.afterAll(async () => {
  await gmContext?.close();
  await userContext?.close();
  await browser?.close();
});

test('no permission errors when opening User Config', async () => {
  const errors = [];
  const handler = msg => {
    if (msg.type() === 'error' && msg.text().includes('lacks permissions')) {
      errors.push(msg.text());
    }
  };
  userPage.on('console', handler);

  await userPage.evaluate(() => game.user.sheet.render(true));
  await userPage.waitForFunction(
    () => !!document.querySelector('#omnipresence-actors'),
    { timeout: 5_000 }
  );
  await userPage.waitForTimeout(2_000); // collect any async errors

  userPage.off('console', handler);

  expect(errors, `Permission errors found:\n${errors.join('\n')}`).toHaveLength(0);

  const actorsPresent = await userPage.evaluate(() =>
    !!document.querySelector('#omnipresence-actors')
  );
  expect(actorsPresent).toBe(true);

  const macrosPresent = await userPage.evaluate(() =>
    !!document.querySelector('#omnipresence-macros')
  );
  expect(macrosPresent).toBe(true);

  await userPage.evaluate(() => game.user.sheet.close());
});

test('prefs are retained after save', async () => {
  // Set both prefs off while dialog is closed, wait for updateUser round-trip to fully settle.
  // A 1 s gap after the flag is confirmed ensures updateUser and any Foundry re-renders that
  // would otherwise race with the dialog open have already completed.
  await userPage.evaluate(() =>
    game.user.setFlag('omnipresence', 'prefs', { actors: false, macros: false })
  );
  await userPage.waitForFunction(
    () => game.user.getFlag('omnipresence', 'prefs')?.actors === false &&
          game.user.getFlag('omnipresence', 'prefs')?.macros === false,
    { timeout: 10_000 }
  );
  await userPage.waitForTimeout(1_000); // let updateUser + any pending re-renders complete

  // Open dialog — no concurrent updateUser in flight, so renders are stable
  await userPage.evaluate(() => game.user.sheet.render(true));
  await userPage.waitForSelector('#omnipresence-actors', { state: 'visible' });
  await userPage.waitForTimeout(200); // let setTimeout(0) in renderUserConfig apply prefs

  // Checkboxes should reflect saved prefs (both off)
  await userPage.waitForFunction(
    () => document.querySelector('#omnipresence-actors')?.checked === false &&
          document.querySelector('#omnipresence-macros')?.checked === false,
    { timeout: 5_000 }
  );

  // Close and reopen to verify retention
  await userPage.evaluate(() => game.user.sheet.close());
  await userPage.waitForTimeout(300);
  await userPage.evaluate(() => game.user.sheet.render(true));
  await userPage.waitForSelector('#omnipresence-actors', { state: 'visible' });
  await userPage.waitForTimeout(200);

  await userPage.waitForFunction(
    () => document.querySelector('#omnipresence-actors')?.checked === false &&
          document.querySelector('#omnipresence-macros')?.checked === false,
    { timeout: 5_000 }
  );

  const flags = await userPage.evaluate(() =>
    game.user.getFlag('omnipresence', 'prefs')
  );
  expect(flags).toMatchObject({ actors: false, macros: false });

  await userPage.evaluate(() => game.user.sheet.close());

  // Cleanup: restore defaults
  await userPage.evaluate(() =>
    game.user.setFlag('omnipresence', 'prefs', { actors: true, macros: true })
  );
});

test('actor sync is suppressed when actors pref is false', async () => {
  // Disable actor sync for User 1 and wait for it to settle
  await userPage.evaluate(() =>
    game.user.setFlag('omnipresence', 'prefs', { actors: false, macros: true })
  );
  await userPage.waitForFunction(
    () => game.user.getFlag('omnipresence', 'prefs')?.actors === false,
    { timeout: 10_000 }
  );
  await userPage.waitForTimeout(500);

  // Snapshot the compendium actor's system data (GM page has pack write access)
  const packId = await gmPage.evaluate(() => `omnipresence.omnipresence-${game.system.id}`);
  const before = await gmPage.evaluate(async (pid) => {
    const pack = game.packs.get(pid);
    if (!pack) throw new Error(`Pack not found: ${pid}`);
    await pack.getDocuments();
    const docs = pack.contents;
    const doc = docs.find(d => d.name === 'Omnipresence Test Actor');
    if (!doc) throw new Error('"Omnipresence Test Actor" not in compendium — push it after enrollment');
    return JSON.stringify(doc.system);
  }, packId);

  // Edit the actor on User 1's page — sync should be suppressed
  await userPage.evaluate(() => {
    const actor = game.actors.getName('Omnipresence Test Actor');
    return actor.update({ 'system.details.biography.value': 'suppression-test-' + Date.now() });
  });

  // Wait for the debounce window (DEBOUNCE_MS + 2 s buffer) to confirm suppression
  await userPage.waitForTimeout(DEBOUNCE_WAIT_MS);

  // Compendium should be unchanged
  const after = await gmPage.evaluate(async (pid) => {
    const pack = game.packs.get(pid);
    await pack.getDocuments();
    const docs = pack.contents;
    const doc = docs.find(d => d.name === 'Omnipresence Test Actor');
    return JSON.stringify(doc.system);
  }, packId);

  expect(after).toBe(before);

  // Cleanup: re-enable sync, push a clean edit so compendium reflects current state
  await userPage.evaluate(() =>
    game.user.setFlag('omnipresence', 'prefs', { actors: true, macros: true })
  );
  await userPage.waitForTimeout(500);
  await userPage.evaluate(() => {
    const actor = game.actors.getName('Omnipresence Test Actor');
    return actor.update({ 'system.details.biography.value': '' });
  });
  await userPage.waitForTimeout(DEBOUNCE_WAIT_MS);
});

test('macro sync is suppressed when macros pref is false', async () => {
  // Disable macro sync for User 1 and wait for it to settle
  await userPage.evaluate(() =>
    game.user.setFlag('omnipresence', 'prefs', { actors: true, macros: false })
  );
  await userPage.waitForFunction(
    () => game.user.getFlag('omnipresence', 'prefs')?.macros === false,
    { timeout: 10_000 }
  );
  await userPage.waitForTimeout(500);

  // Snapshot current macro compendium entries owned by User 1
  const before = await gmPage.evaluate(async () => {
    const pack = game.packs.get('omnipresence.omnipresence-macros');
    if (!pack) throw new Error('Macro compendium pack not found');
    await pack.getDocuments();
    const userDocs = pack.contents.filter(d => d.getFlag('omnipresence', 'ownerName') === 'User 1');
    return JSON.stringify(userDocs.map(d => d.getFlag('omnipresence', 'id')).sort());
  });

  // Save slot-1 macro id then remove it from hotbar — macro sync should be suppressed
  const savedMacroId = await userPage.evaluate(async () => {
    const id = game.user.hotbar[1];
    await game.user.update({ 'hotbar.-=1': null });
    return id;
  });
  expect(savedMacroId).toBeTruthy();

  // Wait for the debounce window to confirm suppression
  await userPage.waitForTimeout(DEBOUNCE_WAIT_MS);

  // Compendium macro entries for User 1 should be unchanged
  const after = await gmPage.evaluate(async () => {
    const pack = game.packs.get('omnipresence.omnipresence-macros');
    await pack.getDocuments();
    const userDocs = pack.contents.filter(d => d.getFlag('omnipresence', 'ownerName') === 'User 1');
    return JSON.stringify(userDocs.map(d => d.getFlag('omnipresence', 'id')).sort());
  });

  expect(after).toBe(before);

  // Cleanup: re-enable macro sync, restore slot 1, wait for push
  await userPage.evaluate(() =>
    game.user.setFlag('omnipresence', 'prefs', { actors: true, macros: true })
  );
  await userPage.waitForTimeout(500);
  await userPage.evaluate(async (macroId) => {
    await game.user.update({ hotbar: { ...game.user.hotbar, 1: macroId } });
  }, savedMacroId);
  await userPage.waitForTimeout(DEBOUNCE_WAIT_MS);
});

test('GM login batch-pushes hotbars to restore entries missed while GM was offline', async () => {
  // Snapshot User 1's current compendium entries
  const before = await gmPage.evaluate(async () => {
    const pack = game.packs.get('omnipresence.omnipresence-macros');
    if (!pack) throw new Error('Macro compendium pack not found');
    await pack.getDocuments();
    return pack.contents
      .filter(d => d.getFlag('omnipresence', 'ownerName') === 'User 1')
      .map(d => d.getFlag('omnipresence', 'id'))
      .sort();
  });
  expect(before.length).toBeGreaterThan(0);

  // Delete them — simulates the push never happening (GM was offline)
  await gmPage.evaluate(async () => {
    const pack = game.packs.get('omnipresence.omnipresence-macros');
    await pack.getDocuments();
    const userDocs = pack.contents.filter(
      d => d.getFlag('omnipresence', 'ownerName') === 'User 1'
    );
    for (const doc of userDocs) await doc.delete();
  });

  const afterDelete = await gmPage.evaluate(async () => {
    const pack = game.packs.get('omnipresence.omnipresence-macros');
    await pack.getDocuments();
    return pack.contents.filter(
      d => d.getFlag('omnipresence', 'ownerName') === 'User 1'
    ).length;
  });
  expect(afterDelete).toBe(0);

  // Simulate GM login: reload (session cookie persists; Foundry resumes the world)
  await gmPage.reload();
  await gmPage.waitForFunction(() => window.game?.ready === true, { timeout: 30_000 });

  // Poll until the batch push has restored the FULL set, then assert exact
  // equality with what was there before.
  //
  // This uses expect.poll rather than page.waitForFunction deliberately:
  // waitForFunction does not await an async predicate, so a predicate declared
  // `async` returns a Promise — always truthy — and the wait passes instantly
  // no matter what the pack contains. That is what made this test read a
  // half-restored pack and fail.
  await expect.poll(
    async () => gmPage.evaluate(async () => {
      const pack = game.packs.get('omnipresence.omnipresence-macros');
      if (!pack) return null;
      pack.clear?.();
      await pack.getDocuments();
      return pack.contents
        .filter(d => d.getFlag('omnipresence', 'ownerName') === 'User 1')
        .map(d => d.getFlag('omnipresence', 'id'))
        .sort();
    }),
    { timeout: 20_000, message: 'GM-login batch push should restore User 1 macro entries' }
  ).toEqual(before);
});
