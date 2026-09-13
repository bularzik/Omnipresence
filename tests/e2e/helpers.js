// Shared harness for the Playwright e2e specs. These drive a live Foundry
// server (see CLAUDE.md) rather than a fixture, so every spec needs the same
// login dance — keep it here rather than copied per spec.

export const FOUNDRY_URL = process.env.FOUNDRY_URL ?? 'http://localhost:30000';

/**
 * Log into the active world as `userName` and wait until the game is ready.
 *
 * The join form differs by version. v13 renders a `<select name="userid">`
 * and marks a user's <option> disabled while another client is connected as
 * that user. On this shared dev server that is routine — an unrelated MCP
 * browser session, or a tab that has not timed out yet — and it is benign:
 * Foundry accepts the login and reconnects the socket, only the stale
 * client-side attribute blocks the form. So wait for the option to *exist*
 * (never for it to be enabled, which may never happen) and clear the attribute
 * before submitting. Selecting via `selectOption` would fail on a disabled
 * option, hence the manual value set plus change event.
 *
 * v14 replaced the dropdown with an `<input name="username">` text field, so
 * the name is typed instead.
 *
 * `waitForFunction(fn, arg, options)`: the timeout must be the THIRD argument.
 * Passing it second makes it the predicate's `arg` and silently leaves the
 * default 10s action timeout in force, which is too short for a v14 world to
 * reach `game.ready` under load.
 */
export async function loginToFoundry(page, userName) {
  await page.goto(`${FOUNDRY_URL}/join`);
  await page.waitForFunction(
    () => !!document.querySelector('select[name="userid"], input[name="username"]'),
    null,
    { timeout: 15_000 }
  );
  const hasSelect = await page.evaluate(() => !!document.querySelector('select[name="userid"]'));
  if (hasSelect) {
    await page.waitForFunction(
      (name) => {
        const sel = document.querySelector('select[name="userid"]');
        return [...(sel?.options ?? [])].some(o => o.text === name);
      },
      userName,
      { timeout: 15_000 }
    );
    await page.evaluate((name) => {
      const sel = document.querySelector('select[name="userid"]');
      const opt = [...sel.options].find(o => o.text === name);
      opt.disabled = false;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, userName);
  } else {
    await page.fill('input[name="username"]', userName);
  }
  // Both dev accounts have blank passwords — no fill needed.
  await page.click('button[type="submit"]');
  await waitForGameReady(page);
}

/** Wait for `game.ready` with a real 60s budget (see loginToFoundry on arg order). */
export async function waitForGameReady(page) {
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 60_000 });
}
