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
    const pack = game.packs.get('omnipresence.omnipresence-actors');
    if (pack?.locked) await pack.configure({ locked: false });
  }
  await SyncEngine.onLogin();
});

Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (userId !== game.user.id) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  SyncEngine.trackLocalModification(actor);
  SyncEngine.debouncedPush(actor);
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
