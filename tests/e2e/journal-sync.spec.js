// tests/e2e/journal-sync.spec.js
import { test, expect, chromium } from '@playwright/test';
import { FOUNDRY_URL, loginToFoundry } from './helpers.js';

const DEBOUNCE_WAIT_MS = 4_000;

let browser, gmContext, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');

  const journalExists = await gmPage.evaluate(() =>
    !!game.journal.getName('Omnipresence Test Journal')
  );
  if (!journalExists) {
    throw new Error(
      'Prerequisite missing: "Omnipresence Test Journal" not found in World B. ' +
      'Create it, grant User 1 OWNER, and enroll it via the Journal directory context menu.'
    );
  }
});

test.afterAll(async () => {
  await gmContext?.close();
  await browser?.close();
});

test('enrolled journal is present in the journals compendium', async () => {
  const inPack = await gmPage.evaluate(async () => {
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const docs = await pack.getDocuments();
    const journal = game.journal.getName('Omnipresence Test Journal');
    const opId = journal.getFlag('omnipresence', 'id');
    return docs.some(d => d.getFlag('omnipresence', 'id') === opId);
  });
  expect(inPack).toBe(true);
});

test('editing an enrolled journal page pushes to the compendium (GM)', async () => {
  const marker = `sync-marker-${Date.now()}`;
  const pushed = await gmPage.evaluate(async (text) => {
    const journal = game.journal.getName('Omnipresence Test Journal');
    const page = journal.pages.contents[0];
    await page.update({ 'text.content': `<p>${text}</p>` });
    return true;
  }, marker);
  expect(pushed).toBe(true);

  await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);

  const compHasMarker = await gmPage.evaluate(async (text) => {
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const docs = await pack.getDocuments();
    const journal = game.journal.getName('Omnipresence Test Journal');
    const opId = journal.getFlag('omnipresence', 'id');
    const comp = docs.find(d => d.getFlag('omnipresence', 'id') === opId);
    return comp.pages.contents.some(p => (p.text?.content ?? '').includes(text));
  }, marker);
  expect(compHasMarker).toBe(true);
});

test('journal sync disabled suppresses push', async () => {
  // Turn journal sync off for the GM, edit, confirm the compendium is unchanged.
  await gmPage.evaluate(async () => {
    await game.user.setFlag('omnipresence', 'prefs', {
      ...(game.user.getFlag('omnipresence', 'prefs') ?? {}),
      journals: false
    });
  });

  const marker = `suppressed-${Date.now()}`;
  await gmPage.evaluate(async (text) => {
    const journal = game.journal.getName('Omnipresence Test Journal');
    const page = journal.pages.contents[0];
    await page.update({ 'text.content': `<p>${text}</p>` });
  }, marker);

  await gmPage.waitForTimeout(DEBOUNCE_WAIT_MS);

  const compHasMarker = await gmPage.evaluate(async (text) => {
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const docs = await pack.getDocuments();
    const journal = game.journal.getName('Omnipresence Test Journal');
    const opId = journal.getFlag('omnipresence', 'id');
    const comp = docs.find(d => d.getFlag('omnipresence', 'id') === opId);
    return comp.pages.contents.some(p => (p.text?.content ?? '').includes(text));
  }, marker);
  expect(compHasMarker).toBe(false);

  // Restore the pref so later runs behave normally.
  await gmPage.evaluate(async () => {
    await game.user.setFlag('omnipresence', 'prefs', {
      ...(game.user.getFlag('omnipresence', 'prefs') ?? {}),
      journals: true
    });
  });
});

test('overlapping pushes of a new journal create one compendium copy', async () => {
  const count = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const { SyncRegistry } = await import('/modules/omnipresence/scripts/sync-registry.js');
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const j = await JournalEntry.create({ name: 'Omni Push Race', pages: [{ name: 'P', type: 'text', text: { content: '<p>x</p>' } }] });
    try {
      const omniId = await SyncRegistry.enroll(j);
      // e.g. the login folder sync and a folder mark both pushing the member.
      await Promise.all([JournalSync.push(j), JournalSync.push(j), JournalSync.push(j)]);
      return (await pack.getDocuments()).filter(d => d.getFlag('omnipresence', 'id') === omniId).length;
    } finally {
      const omniId = j.getFlag('omnipresence', 'id');
      for (const d of await pack.getDocuments()) if (d.getFlag('omnipresence', 'id') === omniId) await d.delete({ omnipresenceInternal: true });
      await SyncRegistry.unenroll(j);
      await j.delete({ omnipresenceInternal: true });
    }
  });
  expect(count).toBe(1);
});
