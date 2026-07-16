// tests/e2e/map-pins.spec.js
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
  // The option may be marked disabled if another automation session (e.g. an
  // unrelated MCP browser) is already connected as this user — that's an
  // expected, benign condition in this shared dev server, not a reason to
  // block. Foundry itself accepts the login and reconnects the socket; only
  // the client-side <option disabled> attribute (stale UI hint) needs to be
  // bypassed to submit the form.
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

test('placing a pin captures it (canonical entryId) in the pack payload', async () => {
  const result = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const omniId = journal.getFlag('omnipresence', 'id');
    const scene = game.scenes.contents[0];

    const [note] = await scene.createEmbeddedDocuments('Note', [{
      entryId: journal.id, x: 1000, y: 1000
    }], { omnipresenceInternal: true }); // internal: we push explicitly below
    await JournalSync.push(journal);

    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
    const pins = comp.getFlag('omnipresence', 'pins') ?? [];
    return {
      pin: pins.find(p => p.note._id === note.id) ?? null,
      sceneName: scene.name,
      omniId,
      noteId: note.id
    };
  });
  expect(result.pin).not.toBeNull();
  expect(result.pin.sceneName).toBe(result.sceneName);
  expect(result.pin.note.entryId).toBe(result.omniId);
});

test('applyAllPins recreates a locally-deleted pin from the payload (heal)', async () => {
  const result = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const scene = game.scenes.contents[0];

    // Delete the local pin (internally — the payload in the pack still has it).
    const before = scene.notes.filter(n => n.entryId === journal.id).map(n => n.id);
    await scene.deleteEmbeddedDocuments('Note', before, { omnipresenceInternal: true });
    const goneLocally = scene.notes.filter(n => n.entryId === journal.id).length === 0;

    await JournalSync.applyAllPins();
    const restored = scene.notes.filter(n => n.entryId === journal.id);
    return {
      goneLocally,
      restoredCount: restored.length,
      restoredIds: restored.map(n => n.id),
      expectedIds: before
    };
  });
  expect(result.goneLocally).toBe(true);
  expect(result.restoredCount).toBe(result.expectedIds.length);
  expect(result.restoredIds.sort()).toEqual(result.expectedIds.sort()); // keepId
});

test('deleting a pin and pushing mirrors the deletion into the payload', async () => {
  const result = await gmPage.evaluate(async () => {
    const { JournalSync } = await import('/modules/omnipresence/scripts/journal-sync.js');
    const journal = game.journal.getName('Omnipresence Test Journal');
    const omniId = journal.getFlag('omnipresence', 'id');
    const scene = game.scenes.contents[0];

    const ids = scene.notes.filter(n => n.entryId === journal.id).map(n => n.id);
    await scene.deleteEmbeddedDocuments('Note', ids, { omnipresenceInternal: true });
    await JournalSync.push(journal);

    const pack = game.packs.get('omnipresence.omnipresence-journals');
    const comp = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === omniId);
    const pins = comp.getFlag('omnipresence', 'pins');
    // applyAllPins must now be a no-op mirror (payload empty, local empty).
    await JournalSync.applyAllPins();
    return {
      payloadIsEmptyArray: Array.isArray(pins) && pins.length === 0,
      localPinCount: scene.notes.filter(n => n.entryId === journal.id).length
    };
  });
  expect(result.payloadIsEmptyArray).toBe(true);
  expect(result.localPinCount).toBe(0);
});
