import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { JournalSync } from './journal-sync.js';
import { FolderSync } from './folder-sync.js';

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

/**
 * Resolve the Folder document for a folder-header context target. v13's
 * ContextMenu passes the `.folder-header` element; the enclosing
 * `.directory-item` carries `data-folder-id` (see DocumentDirectory's own
 * _getFolderContextOptions, which uses the same closest() walk).
 */
function getFolder(header) {
  const el = header instanceof HTMLElement ? header : header?.[0];
  const li = el?.closest?.('.directory-item');
  const id = li?.dataset?.folderId;
  return id ? game.folders.get(id) : null;
}

export function registerFolderContextMenu(entryOptions) {
  entryOptions.push(
    {
      name: 'OMNIPRESENCE.contextMenu.addFolder',
      icon: '<i class="fas fa-link"></i>',
      condition: (header) => {
        if (!journalSyncAvailable()) return false;
        if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return false;
        const folder = getFolder(header);
        if (!folder || folder.type !== 'JournalEntry') return false;
        if (FolderSync.isRoot(folder)) return false;
        // Shown even when nested inside/around another root — markFolder
        // then explains why it refuses, which keeps the rule discoverable.
        return FolderSync.canManage(folder);
      },
      callback: async (header) => {
        const folder = getFolder(header);
        if (folder) await FolderSync.markFolder(folder);
      }
    },
    {
      name: 'OMNIPRESENCE.contextMenu.removeFolder',
      icon: '<i class="fas fa-unlink"></i>',
      condition: (header) => {
        if (!journalSyncAvailable()) return false;
        if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return false;
        const folder = getFolder(header);
        if (!folder || folder.type !== 'JournalEntry') return false;
        return FolderSync.isRoot(folder) && FolderSync.canUnmark(folder);
      },
      callback: async (header) => {
        const folder = getFolder(header);
        if (folder) await FolderSync.unmarkFolder(folder);
      }
    }
  );
}
