import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { JournalSync } from './journal-sync.js';

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
        if (!SyncRegistry.isActorSyncEnabled(game.user.id)) return false;
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
        const key = game.user.isGM
          ? 'OMNIPRESENCE.notifications.enrolled'
          : 'OMNIPRESENCE.notifications.enrolledQueued';
        ui.notifications.info(game.i18n.format(key, { name: actor.name }));
      }
    },
    {
      name: 'OMNIPRESENCE.contextMenu.remove',
      icon: '<i class="fas fa-unlink"></i>',
      condition: (li) => {
        if (!syncAvailable()) return false;
        if (!SyncRegistry.isActorSyncEnabled(game.user.id)) return false;
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

/** Journal sync is available only when the journals compendium pack exists. */
function journalSyncAvailable() {
  return !!game.packs.get(JournalSync.PACK_ID);
}

export function registerJournalContextMenu(entryOptions) {
  entryOptions.push(
    {
      name: 'OMNIPRESENCE.contextMenu.addJournal',
      icon: '<i class="fas fa-link"></i>',
      condition: (li) => {
        if (!journalSyncAvailable()) return false;
        if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return false;
        const journal = game.journal.get(getDocumentId(li));
        if (!journal) return false;
        if (!game.user.isGM && !journal.isOwner) return false;
        return !SyncRegistry.isEnrolled(journal);
      },
      callback: async (li) => {
        const journal = game.journal.get(getDocumentId(li));
        if (!journal) return;
        await SyncRegistry.enroll(journal);
        await JournalSync.push(journal);
        const key = game.user.isGM
          ? 'OMNIPRESENCE.notifications.enrolled'
          : 'OMNIPRESENCE.notifications.enrolledQueued';
        ui.notifications.info(game.i18n.format(key, { name: journal.name }));
      }
    },
    {
      name: 'OMNIPRESENCE.contextMenu.removeJournal',
      icon: '<i class="fas fa-unlink"></i>',
      condition: (li) => {
        if (!journalSyncAvailable()) return false;
        if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return false;
        const journal = game.journal.get(getDocumentId(li));
        if (!journal) return false;
        if (!game.user.isGM && !journal.isOwner) return false;
        return SyncRegistry.isEnrolled(journal);
      },
      callback: async (li) => {
        const journal = game.journal.get(getDocumentId(li));
        if (!journal) return;
        await SyncRegistry.unenroll(journal);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: journal.name }));
      }
    }
  );
}
