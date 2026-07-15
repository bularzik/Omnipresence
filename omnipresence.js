import { SyncRegistry } from './scripts/sync-registry.js';
import { SyncEngine } from './scripts/sync-engine.js';
import { MacroSync } from './scripts/macro-sync.js';
import { JournalSync } from './scripts/journal-sync.js';
import { registerContextMenu, registerJournalContextMenu } from './scripts/context-menu.js';
import { OmnipresenceDashboard } from './scripts/gm-dashboard.js';
import { registerUserConfigInjection } from './scripts/user-config.js';

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
  const actorConflicts = await SyncEngine.onLogin();
  await MacroSync.onLogin();
  const journalConflicts = await JournalSync.onLogin();

  // Surface actor and journal conflicts together in ONE conflicts-only dashboard
  // (both share the static id 'omnipresence-dashboard', so a single instance
  // must carry both lists).
  if ((actorConflicts?.length ?? 0) > 0 || (journalConflicts?.length ?? 0) > 0) {
    new OmnipresenceDashboard({
      conflictActorIds: actorConflicts?.length ? actorConflicts : null,
      conflictJournalIds: journalConflicts?.length ? journalConflicts : null
    }).render(true);
  }
});

Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  if (!SyncRegistry.isActorSyncEnabled(userId)) return;
  if (userId === game.user.id) SyncEngine.trackLocalModification(actor);
  if (game.user.isGM) SyncEngine.debouncedPush(actor);
});

Hooks.on('deleteActor', (actor, options, userId) => {
  if (userId !== game.user.id) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  SyncRegistry.unenroll(actor);
});

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
  MacroSync.handleMacroChange(macro);
});

Hooks.on('updateUser', (user, changes, options, _userId) => {
  if (options?.omnipresenceInternal) return;
  if (!changes.hotbar) return;
  MacroSync.handleHotbarChange(user);
});

Hooks.on('updateJournalEntry', (journal, _changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (!SyncRegistry.isEnrolled(journal)) return;
  if (!SyncRegistry.isJournalSyncEnabled(userId)) return;
  if (userId === game.user.id) JournalSync.trackLocalModification(journal);
  if (game.user.isGM) JournalSync.debouncedPush(journal);
});

Hooks.on('deleteJournalEntry', (journal, _options, userId) => {
  if (userId !== game.user.id) return;
  if (!SyncRegistry.isEnrolled(journal)) return;
  SyncRegistry.unenroll(journal);
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

Hooks.on('getJournalEntryContextOptions', (_directory, entryOptions) => {
  registerJournalContextMenu(entryOptions);
});
