// tests/e2e/user-config.spec.js
import { test, expect, chromium } from '@playwright/test';

const FOUNDRY_URL = 'http://localhost:30000';
const DEBOUNCE_WAIT_MS = 4_000;

let browser, gmContext, userContext, gmPage, userPage;

async function loginToFoundry(page, userName) {
  await page.goto(`${FOUNDRY_URL}/join`);
  // Foundry briefly marks options as disabled during page init — wait until the target option is enabled
  await page.waitForFunction(
    (name) => {
      const sel = document.querySelector('select[name="userid"]');
      return [...(sel?.options ?? [])].some(o => o.text === name && !o.disabled);
    },
    userName,
    { timeout: 15_000 }
  );
  await page.selectOption('select[name="userid"]', { label: userName });
  // Both accounts have blank passwords — no fill needed
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () => window.game?.ready === true,
    { timeout: 30_000 }
  );
}

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
