import { SyncRegistry } from './scripts/sync-registry.js';
import { SyncEngine } from './scripts/sync-engine.js';
import { MacroSync } from './scripts/macro-sync.js';
import { JournalSync } from './scripts/journal-sync.js';
import { registerContextMenu, registerJournalContextMenu, registerFolderContextMenu } from './scripts/context-menu.js';
import { FolderSync } from './scripts/folder-sync.js';
import { OmnipresenceDashboard } from './scripts/gm-dashboard.js';
import { registerUserConfigInjection } from './scripts/user-config.js';
import { LinkRewriter } from './scripts/link-rewriter.js';
import { Onboarding } from './scripts/onboarding.js';
import { runLoginReconcile } from './scripts/reconcile.js';

Hooks.once('init', () => {
  SyncRegistry.register();

  game.settings.registerMenu('omnipresence', 'dashboard', {
    name: 'OMNIPRESENCE.settings.dashboard.name',
    label: 'OMNIPRESENCE.settings.dashboard.label',
    hint: 'OMNIPRESENCE.settings.dashboard.hint',
    icon: 'fas fa-link',
    type: OmnipresenceDashboard,
    restricted: false
  });

  registerUserConfigInjection();
});

Hooks.once('ready', async () => {
  if (game.user.isGM) {
    const pack = game.packs.get(SyncEngine.PACK_ID);
    if (pack && pack.locked) await pack.configure({ locked: false });
    const macroPack = game.packs.get(MacroSync.PACK_ID);
    if (macroPack && macroPack.locked) await macroPack.configure({ locked: false });
    const journalPack = game.packs.get(JournalSync.PACK_ID);
    if (journalPack && journalPack.locked) await journalPack.configure({ locked: false });
  }
  // First-sync consent gate: on a user's first contact with this world, hold
  // all sync/import until they choose what to sync (opt-in). Existing worlds
  // are detected and back-filled silently, returning true. A dismissed prompt
  // returns false — skip sync this session and re-ask next login.
  const proceed = await Onboarding.ensureOnboarded();
  if (proceed) {
    await runLoginReconcile();
  }

  // Phase 2 of login link rewriting: every enrolled doc now exists locally
  // (imports above are done), so canonical omnipresence ids that could not
  // resolve at pull time — targets imported after the linking doc, or in an
  // earlier session — heal now.
  await LinkRewriter.localizeAll();

  // Phase 2b: mirror map pins once every journal/scene that will exist this
  // session does — heals pins whose targets arrived after the journal's pull.
  await JournalSync.applyAllPins();

  // Cancel (never flush) pending debounced pushes when the page goes away —
  // a timer firing into the world-teardown window produces partial pack
  // writes. Cancellation is synchronous and lossless: the edits are already
  // dirty-marked and push at the next login. (The inverse — flushing on
  // unload — was removed in v0.0.3 for racing shutdown.)
  window.addEventListener('beforeunload', () => {
    SyncEngine.cancelPending();
    JournalSync.cancelPending();
    MacroSync.cancelPending();
    FolderSync.cancelPending();
  });
});

// Compendium copies fire the same document hooks as world docs (our own pack
// writes included). Every handler below must ignore pack docs (`doc.pack`), or
// a GM push feeds back on itself: the pack copy gets marked dirty and
// re-pushed onto itself — stale-cache resurrection, ownerName wiped (its
// ownership is stripped), and endless debounced churn.
Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (actor.pack) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  if (!SyncRegistry.isActorSyncEnabled(userId)) return;
  if (userId === game.user.id) SyncEngine.trackLocalModification(actor);
  if (game.user.isGM) SyncEngine.debouncedPush(actor);
});

// Deleting an enrolled actor is deliberately NOT an unenroll (README, Notes):
// the pack copy stays and the actor is re-imported at the next login, so an
// accidental delete recovers. Unenrolling here would also strip the owner's
// allow-list entry and block that re-import for good. (An earlier version
// called unenroll from this hook; it silently rejected because the document
// was already gone, which is the only reason the contract held — op-74f.)
// Folder members are the exception and are handled in deleteJournalEntry.
Hooks.on('deleteActor', (_actor, _options, _userId) => {});

// v13 renamed directory context-menu hooks to get{DocumentName}ContextOptions;
// the v12 name (getActorDirectoryEntryContext) no longer fires. The callback
// receives (application, entryOptions) — the entry element passed to each
// option's condition/callback is a native HTMLElement, which getDocumentId
// already handles.
Hooks.on('getActorContextOptions', (directory, entryOptions) => {
  registerContextMenu(entryOptions);
});

// Embedded-document changes (inventory, spells, features, effects, and effects
// nested on items) do not fire updateActor — route them to the owning actor.
// create/delete hooks fire (doc, options, userId); update fires
// (doc, changes, options, userId), so userId arrives in different positions.
const onEmbeddedCreateDelete = (doc, options, userId) =>
  SyncEngine.handleEmbeddedChange(doc, options, userId);
const onEmbeddedUpdate = (doc, changes, options, userId) =>
  // changes unused — the whole actor is pushed, not a delta.
  SyncEngine.handleEmbeddedChange(doc, options, userId);

for (const hook of ['createItem', 'deleteItem', 'createActiveEffect', 'deleteActiveEffect']) {
  Hooks.on(hook, onEmbeddedCreateDelete);
}
for (const hook of ['updateItem', 'updateActiveEffect']) {
  Hooks.on(hook, onEmbeddedUpdate);
}

Hooks.on('updateMacro', (macro, _changes, options, _userId) => {
  if (options?.omnipresenceInternal) return;
  if (macro.pack) return;
  MacroSync.handleMacroChange(macro);
});

Hooks.on('updateUser', (user, changes, options, _userId) => {
  if (options?.omnipresenceInternal) return;
  if (!changes.hotbar) return;
  MacroSync.handleHotbarChange(user);
});

// A player queued a folder mark/unmark or a member delete while this GM is
// connected: honour it now instead of at the next login. Pending writes are
// deliberately NOT omnipresenceInternal so this fires; the GM's own clears
// use `-=` keys (null values) and an empty array, which do not match here.
Hooks.on('updateUser', (_user, changes, _options, _userId) => {
  if (!game.user.isGM) return;
  const omni = changes.flags?.omnipresence;
  if (!omni) return;
  const hasPendingRoot = Object.values(omni.pendingRoots ?? {}).some(v => v && typeof v === 'object');
  const hasPendingDelete = Array.isArray(omni.pendingDeletes) && omni.pendingDeletes.length > 0;
  if (hasPendingRoot || hasPendingDelete) FolderSync.materializePending().catch(err => console.error('Omnipresence | pending folder materialize failed', err));
});

Hooks.on('updateJournalEntry', (journal, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (journal.pack) return;
  // Folder membership first: a move into/out of a synced folder enrolls or
  // unenrolls, and the ordinary dirty-mark/push below must see that state.
  if ('folder' in changes) {
    FolderSync.handleMemberMove(journal, changes, options, userId)
      .catch(err => console.error('Omnipresence | updateJournalEntry (folder) handling failed', err));
  }
  if (!SyncRegistry.isEnrolled(journal)) return;
  if (!SyncRegistry.isJournalSyncEnabled(userId)) return;
  if (userId === game.user.id) JournalSync.trackLocalModification(journal);
  if (game.user.isGM) JournalSync.debouncedPush(journal);
});

Hooks.on('deleteJournalEntry', (journal, options, userId) => {
  if (journal.pack) return; // deleting a pack copy must not unenroll the world doc
  // Folder members: tombstone + pack delete (or a pending record for a GM).
  if (journal.getFlag('omnipresence', 'viaFolder')) {
    FolderSync.handleMemberDelete(journal, options, userId)
      .catch(err => console.error('Omnipresence | deleteJournalEntry handling failed', err));
    return;
  }
  // Individually enrolled journals keep the re-import contract (see deleteActor).
});

// Page changes don't fire updateJournalEntry — route them to the owning journal.
// create/delete fire (doc, options, userId); update fires (doc, changes, options, userId).
const onPageCreateDelete = (doc, options, userId) =>
  JournalSync.handlePageChange(doc, options, userId);
const onPageUpdate = (doc, _changes, options, userId) =>
  JournalSync.handlePageChange(doc, options, userId);

for (const hook of ['createJournalEntryPage', 'deleteJournalEntryPage']) {
  Hooks.on(hook, onPageCreateDelete);
}
Hooks.on('updateJournalEntryPage', onPageUpdate);

// Map-pin changes (scene Note docs) don't fire journal hooks — route them to
// the journal the pin points at. create/delete fire (doc, options, userId);
// update fires (doc, changes, options, userId).
const onNoteCreateDelete = (doc, options, userId) =>
  JournalSync.handleNoteChange(doc, options, userId);
const onNoteUpdate = (doc, _changes, options, userId) =>
  JournalSync.handleNoteChange(doc, options, userId);
for (const hook of ['createNote', 'deleteNote']) {
  Hooks.on(hook, onNoteCreateDelete);
}
Hooks.on('updateNote', onNoteUpdate);

Hooks.on('getJournalEntryContextOptions', (_directory, entryOptions) => {
  registerJournalContextMenu(entryOptions);
});

// --- Journal folder sync -----------------------------------------------------
// Folder hooks: create/delete fire (doc, options, userId); update fires
// (doc, changes, options, userId). preDeleteFolder captures the subtree before
// Foundry removes or moves it, because deleteFolder fires too late to see it.
Hooks.on('getFolderContextOptions', (_directory, entryOptions) => {
  registerFolderContextMenu(entryOptions);
});
Hooks.on('createFolder', (folder, options, userId) =>
  FolderSync.handleFolderCreate(folder, options, userId)
    .catch(err => console.error('Omnipresence | createFolder handling failed', err)));
Hooks.on('updateFolder', (folder, changes, options, userId) =>
  FolderSync.handleFolderUpdate(folder, changes, options, userId)
    .catch(err => console.error('Omnipresence | updateFolder handling failed', err)));
Hooks.on('preDeleteFolder', (folder, options, userId) =>
  FolderSync.capturePreDelete(folder, options, userId));
Hooks.on('deleteFolder', (folder, options, userId) =>
  FolderSync.handleFolderDelete(folder, options, userId)
    .catch(err => console.error('Omnipresence | deleteFolder handling failed', err)));
// A journal created inside a synced folder joins the sync (the single-journal
// path never enrolled on create; this fires only for folder members).
Hooks.on('createJournalEntry', (journal, options, userId) =>
  FolderSync.handleMemberCreate(journal, options, userId)
    .catch(err => console.error('Omnipresence | createJournalEntry handling failed', err)));
