// tests/e2e/sync-followups.spec.js
import { test, expect, chromium } from '@playwright/test';
import { FOUNDRY_URL, loginToFoundry } from './helpers.js';

let browser, gmContext, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  const ok = await gmPage.evaluate(() =>
    !!game.journal.getName('Omnipresence Test Journal') &&
    !!game.actors.getName('Omnipresence Test Actor')
  );
  if (!ok) throw new Error('Prerequisites missing in World B (test journal/actor).');
});

test.afterAll(async () => {
  await gmContext?.close();
  await browser?.close();
});

test('macro push canonicalizes command links; pull localizes them', async () => {
  const result = await gmPage.evaluate(async () => {
    const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
    const actor = game.actors.getName('Omnipresence Test Actor');
    const actorOmni = actor.getFlag('omnipresence', 'id');

    // Create a macro linking the enrolled actor and put it on the GM hotbar.
    const macro = await Macro.create({
      name: 'OmniLink Test Macro',
      type: 'script',
      command: `// @UUID[Actor.${actor.id}]{Hero}`
    });
    await game.user.update({ hotbar: { ...game.user.hotbar, 9: macro.id } }, { omnipresenceInternal: true });
    await MacroSync.pushForUser(game.user);

    const pack = game.packs.get('omnipresence.omnipresence-macros');
    const docs = await pack.getDocuments();
    const ompId = macro.getFlag('omnipresence', 'id');
    const comp = docs.find(d => d.getFlag('omnipresence', 'id') === ompId);
    const canonical = comp?._source?.command ?? '';

    // Cleanup: drop the slot and the macro, and remove the pack copy.
    await game.user.update({ hotbar: { ...game.user.hotbar, 9: null } }, { omnipresenceInternal: true });
    await comp?.delete();
    await macro.delete();

    return { canonical, actorOmni, actorLocalId: actor.id };
  });
  expect(result.canonical).toContain(`@UUID[Actor.${result.actorOmni}]`);
  expect(result.canonical).not.toContain(result.actorLocalId);
});

test('deleting an MEJ relationship key propagates to the pack copy', async () => {
  const result = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const page = journal.pages.contents[0];
    const ompId = journal.getFlag('omnipresence', 'id');

    // Ensure a relationship key exists locally, push, confirm in pack.
    const key = 'kkkkkkkkkkkkkkkk';
    await page.update({
      [`flags.monks-enhanced-journal.relationships.${key}`]: { id: key, uuid: `JournalEntry.${key}` }
    }, { omnipresenceInternal: true });
    await JournalSync.push(journal);
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    let comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === ompId);
    const presentAfterAdd = key in (comp.pages.contents[0].flags['monks-enhanced-journal']?.relationships ?? {});

    // Delete the key locally, push again — replacement write must drop it.
    await page.update({
      [`flags.monks-enhanced-journal.relationships.-=${key}`]: null
    }, { omnipresenceInternal: true });
    await JournalSync.push(journal);
    comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === ompId);
    const presentAfterDelete = key in (comp.pages.contents[0].flags['monks-enhanced-journal']?.relationships ?? {});

    return { presentAfterAdd, presentAfterDelete };
  });
  expect(result.presentAfterAdd).toBe(true);
  expect(result.presentAfterDelete).toBe(false);
});
