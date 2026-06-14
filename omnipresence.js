import { SyncRegistry } from './scripts/sync-registry.js';
import { SyncEngine } from './scripts/sync-engine.js';
import { registerContextMenu } from './scripts/context-menu.js';
import { OmnipresenceDashboard } from './scripts/gm-dashboard.js';

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
});

Hooks.once('ready', async () => {
  if (game.user.isGM) {
    const pack = game.packs.get(SyncEngine.PACK_ID);
    if (pack && pack.locked) await pack.configure({ locked: false });
  }
  await SyncEngine.onLogin();
});

Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  // The editing user marks the actor dirty (they can write their own actor).
  // Fire-and-forget: not awaited. The marker drives the next login-time sync
  // decision (decideSyncAction); the GM's debounced push persists current state.
  if (userId === game.user.id) SyncEngine.trackLocalModification(actor);
  // A GM-role client performs the compendium write (only GMs can write packs).
  if (game.user.isGM) SyncEngine.debouncedPush(actor);
});

Hooks.on('deleteActor', (actor, options, userId) => {
  if (userId !== game.user.id) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  SyncRegistry.unenroll(actor);
});

// Best-effort flush — browser does not await async handlers on unload.
// Edits made within the 2s debounce window at logout may not sync.
window.addEventListener('beforeunload', () => {
  SyncEngine.flushPending();
});

Hooks.on('getActorDirectoryEntryContext', (html, entryOptions) => {
  registerContextMenu(entryOptions);
});
