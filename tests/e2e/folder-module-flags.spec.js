// tests/e2e/folder-module-flags.spec.js — other modules' folder flags cross
// worlds with the folder (MEJ Campaign Companion marks a campaign with one),
// with bare journal-id links translated and world-local keys kept home.
import { test, expect, chromium } from '@playwright/test';
import { loginToFoundry } from './helpers.js';
import { buildTree, cleanup, PACK, ROOT_NAME } from './folder-helpers.js';

const CC = 'mej-campaign-companion';
let browser, gmContext, gmPage;

test.beforeAll(async () => {
  browser = await chromium.launch();
  gmContext = await browser.newContext();
  gmPage = await gmContext.newPage();
  await loginToFoundry(gmPage, 'Gamemaster');
});

test.afterAll(async () => {
  await gmContext?.close();
  await browser?.close();
});

// Flag the probe root as a campaign whose default timeline is J1, then mark it.
async function buildCampaignAndMark(page) {
  await buildTree(page);
  return page.evaluate(async ({ ROOT_NAME, CC }) => {
    const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
    const root = game.folders.getName(ROOT_NAME);
    const j1 = game.journal.getName(`${ROOT_NAME} J1`);
    await root.update({ flags: { [CC]: { campaign: { ownershipDefault: 2, defaultTimelineId: j1.id, contributors: { userIds: [game.user.id], groupIds: [] } } } } }, { omnipresenceInternal: true });
    const rootId = await FolderSync.markFolder(root);
    return { rootId, j1Omni: j1.getFlag('omnipresence', 'id') };
  }, { ROOT_NAME, CC });
}

const packRootFlags = (page, rootId) => page.evaluate(({ PACK, rootId }) =>
  structuredClone(game.packs.get(PACK).folders.get(rootId)?._source.flags ?? null), { PACK, rootId });

test('a campaign folder flag reaches the pack canonicalized and a target world as a campaign', async () => {
  try {
    const { rootId, j1Omni } = await buildCampaignAndMark(gmPage);

    const packed = await packRootFlags(gmPage, rootId);
    expect(packed[CC]).toEqual({ campaign: { ownershipDefault: 2, defaultTimelineId: j1Omni } });
    expect(packed.omnipresence.moduleFlags).toBe(true);
    expect(packed.omnipresence.id).toBe(rootId);

    const result = await gmPage.evaluate(async ({ ROOT_NAME, CC }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      const { LinkRewriter } = await import('/modules/omnipresence/scripts/link-rewriter.js');
      // Simulate another world: nothing local, but the pack tree exists.
      for (const j of game.journal.filter(j => j.name.startsWith(ROOT_NAME))) await j.delete({ omnipresenceInternal: true });
      for (const f of game.folders.filter(f => f.name.startsWith(ROOT_NAME) && f.folder)) await f.delete({ omnipresenceInternal: true });
      await game.folders.getName(ROOT_NAME).delete({ omnipresenceInternal: true });

      await FolderSync.reconcileFolders();
      await LinkRewriter.localizeAll();

      const root = game.folders.getName(ROOT_NAME);
      return {
        campaign: root?.flags?.[CC]?.campaign,
        j1: game.journal.getName(`${ROOT_NAME} J1`)?.id,
        isRoot: root?.getFlag('omnipresence', 'root')
      };
    }, { ROOT_NAME, CC });

    expect(result.isRoot).toBe(true);
    expect(result.campaign).toEqual({ ownershipDefault: 2, defaultTimelineId: result.j1 });
  } finally {
    await cleanup(gmPage);
  }
});

test('a pre-fix pack folder (no marker) merges: it never strips local flags, adds its own, and is filled from local', async () => {
  try {
    const { rootId, j1Omni } = await buildCampaignAndMark(gmPage);

    // Make the pack root look like 0.7.0 wrote it (no module scopes, no
    // marker), except for one scope another world has already contributed.
    await gmPage.evaluate(async ({ PACK, rootId, CC }) => {
      const f = game.packs.get(PACK).folders.get(rootId);
      const flags = structuredClone(f._source.flags);
      delete flags[CC];
      delete flags.omnipresence.moduleFlags;
      flags['other-world-module'] = { note: 'from B' };
      await f.update({ flags }, { omnipresenceInternal: true, recursive: false });
    }, { PACK, rootId, CC });

    const local = await gmPage.evaluate(async ({ ROOT_NAME, CC }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      await FolderSync.reconcileFolders();
      const flags = game.folders.getName(ROOT_NAME).flags;
      return { campaign: flags[CC]?.campaign, other: flags['other-world-module'] };
    }, { ROOT_NAME, CC });
    expect(local.campaign?.ownershipDefault).toBe(2);
    expect(local.campaign?.contributors?.userIds?.length).toBe(1);
    expect(local.other).toEqual({ note: 'from B' });

    const healed = await packRootFlags(gmPage, rootId);
    expect(healed[CC]).toEqual({ campaign: { ownershipDefault: 2, defaultTimelineId: j1Omni } });
    expect(healed['other-world-module']).toEqual({ note: 'from B' });
    expect(healed.omnipresence.moduleFlags).toBeUndefined();
  } finally {
    await cleanup(gmPage);
  }
});

test('a flag-only edit pushes; removing the scope removes it from the pack and keeps pack bookkeeping', async () => {
  try {
    const { rootId } = await buildCampaignAndMark(gmPage);
    const before = await packRootFlags(gmPage, rootId);

    await gmPage.evaluate(async ({ ROOT_NAME, CC }) => {
      await game.folders.getName(ROOT_NAME).update({ [`flags.${CC}.campaign.ownershipDefault`]: 3 });
    }, { ROOT_NAME, CC });
    await expect.poll(async () => (await packRootFlags(gmPage, rootId))[CC]?.campaign?.ownershipDefault,
      { timeout: 20_000, message: 'flag edit pushed' }).toBe(3);

    await gmPage.evaluate(async ({ ROOT_NAME, CC }) => {
      await game.folders.getName(ROOT_NAME).update({ [`flags.-=${CC}`]: null });
    }, { ROOT_NAME, CC });
    await expect.poll(async () => CC in (await packRootFlags(gmPage, rootId)),
      { timeout: 20_000, message: 'scope removal pushed' }).toBe(false);

    const after = await packRootFlags(gmPage, rootId);
    expect(after.omnipresence.id).toBe(before.omnipresence.id);
    expect(after.omnipresence.ownerName).toBe(before.omnipresence.ownerName);
    expect(after.omnipresence.tombstones).toEqual(before.omnipresence.tombstones);
  } finally {
    await cleanup(gmPage);
  }
});

test('a pack flag change pulls over local flags but keeps local contributors', async () => {
  try {
    const { rootId } = await buildCampaignAndMark(gmPage);
    // Another world pushed a new baseline.
    await gmPage.evaluate(async ({ PACK, rootId, CC }) => {
      const f = game.packs.get(PACK).folders.get(rootId);
      await f.update({ [`flags.${CC}.campaign.ownershipDefault`]: 1 }, { omnipresenceInternal: true });
    }, { PACK, rootId, CC });

    const local = await gmPage.evaluate(async ({ ROOT_NAME, CC }) => {
      const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
      await FolderSync.reconcileFolders();
      const root = game.folders.getName(ROOT_NAME);
      return { campaign: root.flags[CC]?.campaign, omni: root.flags.omnipresence, userId: game.user.id };
    }, { ROOT_NAME, CC });
    expect(local.campaign.ownershipDefault).toBe(1);
    expect(local.campaign.contributors).toEqual({ userIds: [local.userId], groupIds: [] });
    expect(local.omni.root).toBe(true);
    expect(local.omni.id).toBe(rootId);
  } finally {
    await cleanup(gmPage);
  }
});
