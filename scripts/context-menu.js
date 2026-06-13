import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';

export function registerContextMenu(entryOptions) {
  entryOptions.push(
    {
      name: 'OMNIPRESENCE.contextMenu.add',
      icon: '<i class="fas fa-link"></i>',
      condition: (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return !SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return;
        await SyncRegistry.enroll(actor);
        await SyncEngine.push(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.enrolled', { name: actor.name }));
      }
    },
    {
      name: 'OMNIPRESENCE.contextMenu.remove',
      icon: '<i class="fas fa-unlink"></i>',
      condition: (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return;
        await SyncRegistry.unenroll(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
      }
    }
  );
}
