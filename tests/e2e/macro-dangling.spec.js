// tests/e2e/macro-dangling.spec.js — op-bhm: a hotbar slot whose local macro
// was deleted (Foundry never clears the slot) must NOT delete the shared pack
// copy at the next GM login; the pull phase restores the local macro and
// re-points the slot instead.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';

const NAME = 'Omni Dangling Probe';
const SLOT = 9;
let browser, ctx, gmPage, prevSlot;

test.beforeAll(async () => {
  browser = await chromium.launch();
  ctx = await browser.newContext();
  gmPage = await ctx.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
  prevSlot = await gmPage.evaluate((SLOT) => game.user.hotbar[SLOT] ?? null, SLOT);
});

test.afterAll(async () => {
  await gmPage?.evaluate(async ({ NAME, SLOT, prevSlot }) => {
    const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
    await game.user.update(prevSlot ? { [`hotbar.${SLOT}`]: prevSlot } : { [`hotbar.-=${SLOT}`]: null }, { omnipresenceInternal: true });
    for (const m of game.macros.filter(m => m.name === NAME)) await m.delete({ omnipresenceInternal: true });
    const pack = game.packs.get(MacroSync.PACK_ID);
    for (const d of await pack.getDocuments()) if (d.name === NAME) await d.delete();
  }, { NAME, SLOT, prevSlot }).catch(() => {});
  await ctx?.close();
  await browser?.close();
});

test('a dangling hotbar slot keeps the pack copy and the login pull restores the macro', async () => {
  const out = await gmPage.evaluate(async ({ NAME, SLOT }) => {
    const { MacroSync } = await import('/modules/omnipresence/scripts/macro-sync.js');
    const pack = game.packs.get(MacroSync.PACK_ID);
    const macro = await Macro.create({ name: NAME, type: 'script', command: 'console.log("omni dangling")' });
    await game.user.update({ [`hotbar.${SLOT}`]: macro.id }, { omnipresenceInternal: true });
    await MacroSync.pushForUser(game.user);
    const ompId = game.macros.get(macro.id).getFlag('omnipresence', 'id');
    const inPack = async () => { pack.clear(); return (await pack.getDocuments()).some(d => d.getFlag('omnipresence', 'id') === ompId); };
    const pushed = await inPack();
    // Delete the macro locally; the slot keeps pointing at the dead id.
    await macro.delete({ omnipresenceInternal: true });
    const dangling = game.user.hotbar[SLOT] === macro.id && !game.macros.get(macro.id);
    await MacroSync.onLogin();
    const survived = await inPack();
    const restored = game.macros.find(m => m.getFlag('omnipresence', 'id') === ompId);
    return { pushed, dangling, survived, restored: !!restored, slotPointsAtRestored: !!restored && game.user.hotbar[SLOT] === restored.id };
  }, { NAME, SLOT });
  expect(out.pushed).toBe(true);
  expect(out.dangling).toBe(true);
  expect(out.survived).toBe(true);
  expect(out.restored).toBe(true);
  expect(out.slotPointsAtRestored).toBe(true);
});
