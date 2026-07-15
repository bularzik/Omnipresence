// tests/e2e/link-rewriting.spec.js
import { test, expect, chromium } from '@playwright/test';

const FOUNDRY_URL = 'http://localhost:30000';
const DEBOUNCE_WAIT_MS = 4_000;

let browser, gmContext, gmPage;

async function loginToFoundry(page, userName) {
  await page.goto(`${FOUNDRY_URL}/join`);
  await page.waitForFunction(
    (name) => {
      const sel = document.querySelector('select[name="userid"]');
      return [...(sel?.options ?? [])].some(o => o.text === name && !o.disabled);
    },
    userName,
    { timeout: 15_000 }
  );
  await page.selectOption('select[name="userid"]', { label: userName });
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => window.game?.ready === true, { timeout: 30_000 });
}

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');

  const ok = await gmPage.evaluate(() =>
    !!game.journal.getName('Omnipresence Test Journal') &&
    !!game.actors.getName('Omnipresence Test Actor')
  );
  if (!ok) {
    throw new Error(
      'Prerequisites missing in World A: enrolled "Omnipresence Test Journal" ' +
      'and enrolled "Omnipresence Test Actor" are required.'
    );
  }
});

test.afterAll(async () => {
  await gmContext?.close();
  await browser?.close();
});

test('push canonicalizes enrolled links; non-enrolled links untouched', async () => {
  const result = await gmPage.evaluate(async (waitMs) => {
    const journal = game.journal.getName('Omnipresence Test Journal');
    const actor = game.actors.getName('Omnipresence Test Actor');
    const actorOmni = actor.getFlag('omnipresence', 'id');
    const fakeSceneId = 'zzzzzzzzzzzzzzzz'; // deliberately not a real/enrolled doc

    const page = journal.pages.contents[0];
    await page.update({
      'text.content':
        `<p>@UUID[Actor.${actor.id}]{Hero} and @UUID[Scene.${fakeSceneId}]{Map}</p>`
    });
    await new Promise(r => setTimeout(r, waitMs)); // debounced push

    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const docs = await pack.getDocuments();
    const opId = journal.getFlag('omnipresence', 'id');
    const comp = docs.find(d => d.getFlag('omnipresence', 'id') === opId);
    const content = comp.pages.contents[0]?.text?.content ?? '';
    return { content, actorOmni, fakeSceneId, actorLocalId: actor.id };
  }, DEBOUNCE_WAIT_MS);

  expect(result.content).toContain(`@UUID[Actor.${result.actorOmni}]`);
  expect(result.content).toContain(`@UUID[Scene.${result.fakeSceneId}]`); // untouched
  expect(result.content).not.toContain(`Actor.${result.actorLocalId}`);
});

test('force-pull localizes the canonical token back to the local actor id', async () => {
  const result = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const actor = game.actors.getName('Omnipresence Test Actor');
    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const docs = await pack.getDocuments();
    const opId = journal.getFlag('omnipresence', 'id');
    const comp = docs.find(d => d.getFlag('omnipresence', 'id') === opId);

    await JournalSync.pull(journal, comp);
    const content = journal.pages.contents[0]?.text?.content ?? '';
    return { content, actorLocalId: actor.id, actorOmni: actor.getFlag('omnipresence', 'id') };
  });

  expect(result.content).toContain(`@UUID[Actor.${result.actorLocalId}]`);
  expect(result.content).not.toContain(result.actorOmni);
});

test('localizeAll heals a dangling token once the target exists', async () => {
  const result = await gmPage.evaluate(async () => {
    const { LinkRewriter } = await import('/modules/omnipresence/scripts/link-rewriter.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const actor = game.actors.getName('Omnipresence Test Actor');
    const actorOmni = actor.getFlag('omnipresence', 'id');
    const page = journal.pages.contents[0];

    // Simulate a pull that could not resolve (target absent at pull time).
    await page.update(
      { 'text.content': `<p>@UUID[Actor.${actorOmni}]{Hero}</p>` },
      { omnipresenceInternal: true }
    );
    await LinkRewriter.localizeAll();
    const content = journal.pages.contents[0]?.text?.content ?? '';
    return { content, actorLocalId: actor.id, actorOmni };
  });

  expect(result.content).toContain(`@UUID[Actor.${result.actorLocalId}]`);
  expect(result.content).not.toContain(result.actorOmni);
});
