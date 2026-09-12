// Shared helpers for the journal-folder-sync e2e specs (Increment 1 and
// beyond): build a probe tree, and clean up every probe artefact local and
// pack, regardless of state.

export const PACK = 'omnipresence.omnipresence-journals';
export const ROOT_NAME = 'Omni Folder Probe';
export const SUB_NAME = 'Omni Folder Probe Sub';

// Build root/sub with one journal each; returns local ids.
export async function buildTree(page) {
  return page.evaluate(async ({ ROOT_NAME, SUB_NAME }) => {
    const Folder = CONFIG.Folder.documentClass;
    const root = await Folder.create({ name: ROOT_NAME, type: 'JournalEntry' });
    const sub = await Folder.create({ name: SUB_NAME, type: 'JournalEntry', folder: root.id, color: '#336699' });
    const j1 = await JournalEntry.create({ name: `${ROOT_NAME} J1`, folder: root.id, pages: [{ name: 'p', type: 'text', text: { content: '<p>one</p>' } }] });
    const j2 = await JournalEntry.create({ name: `${ROOT_NAME} J2`, folder: sub.id, pages: [{ name: 'p', type: 'text', text: { content: '<p>two</p>' } }] });
    return { rootId: root.id, subId: sub.id, j1: j1.id, j2: j2.id };
  }, { ROOT_NAME, SUB_NAME });
}

// Remove every probe artefact, local and pack, regardless of state.
export async function cleanup(page) {
  await page.evaluate(async ({ PACK, ROOT_NAME }) => {
    const { FolderSync } = await import('/modules/omnipresence/scripts/folder-sync.js');
    for (const f of game.folders.filter(f => f.name === ROOT_NAME)) {
      if (FolderSync.isRoot(f)) await FolderSync.unmarkFolder(f);
    }
    for (const j of game.journal.filter(j => j.name.startsWith(ROOT_NAME))) await j.delete({ omnipresenceInternal: true });
    const subs = game.folders.filter(f => f.name.startsWith(ROOT_NAME) && f.folder);
    for (const f of subs) await f.delete({ omnipresenceInternal: true });
    for (const f of game.folders.filter(f => f.name === ROOT_NAME)) await f.delete({ omnipresenceInternal: true });
    const pack = game.packs.get(PACK);
    for (const d of await pack.getDocuments()) if (d.name.startsWith(ROOT_NAME)) await d.delete({ omnipresenceInternal: true });
    for (const f of [...pack.folders].reverse()) if (f.name.startsWith(ROOT_NAME)) await f.delete({ omnipresenceInternal: true });
  }, { PACK, ROOT_NAME });
}
