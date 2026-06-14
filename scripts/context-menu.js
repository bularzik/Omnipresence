import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';

/**
 * Resolve the actor document id from a context-menu target that may be a
 * jQuery object (v12 / early v13) or a native HTMLElement (v13 ApplicationV2).
 *
 * The attribute name differs by version: v13's DocumentDirectory renders
 * entries with `data-entry-id`, while older directories used `data-document-id`.
 * Try both so enroll/unenroll works across versions.
 */
function getDocumentId(li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  if (el?.dataset?.entryId) return el.dataset.entryId;
  if (el?.dataset?.documentId) return el.dataset.documentId;
  // Not dead code: v12 set the id via jQuery's $.data() cache rather than a
  // data-* attribute, so .dataset is empty but .data(...) resolves.
  if (typeof li?.data === 'function') return li.data('entryId') ?? li.data('documentId');
  return null;
}

/** Sync is available only when a compendium pack exists for the active system. */
function syncAvailable() {
  return !!game.packs.get(SyncEngine.PACK_ID);
}

export function registerContextMenu(entryOptions) {
  entryOptions.push(
    {
      name: 'OMNIPRESENCE.contextMenu.add',
      icon: '<i class="fas fa-link"></i>',
      condition: (li) => {
        if (!syncAvailable()) return false;
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return !SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(getDocumentId(li));
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
        if (!syncAvailable()) return false;
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(getDocumentId(li));
        if (!actor) return;
        await SyncRegistry.unenroll(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
      }
    }
  );
}
