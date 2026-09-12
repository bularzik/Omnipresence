import { SyncRegistry } from './sync-registry.js';
import { JournalSync } from './journal-sync.js';
import {
  collectFolderTree,
  diffFolderTree,
  findSyncedRootId,
  classifyMembership,
  resolveTombstoneAction
} from './sync-logic.js';

const DEBOUNCE_MS = 2000;
const FOLDER_TYPE = 'JournalEntry';

/**
 * Folder-level journal sync. A marked JournalEntry folder (a "root") syncs
 * its whole subtree through the journals pack: the hierarchy lives there as
 * real compendium Folder documents (pack folder _id === the folder's
 * omnipresence id), and member journals are ordinary enrolled journals whose
 * `viaFolder` flag names their root. Pure decisions live in sync-logic.js;
 * this class is the Foundry glue.
 */
export class FolderSync {
  static _timers = new Map(); // root local id → timeout handle

  static get PACK_ID() {
    return JournalSync.PACK_ID;
  }

  static _getPack() {
    return game.packs.get(this.PACK_ID);
  }

  static get _FolderClass() {
    return CONFIG.Folder.documentClass;
  }

  // --- local tree queries ---------------------------------------------------

  /** Every JournalEntry folder in this world as a plain record (Folder#toObject). */
  static _folderRecords() {
    return game.folders.filter(f => f.type === FOLDER_TYPE).map(f => f.toObject());
  }

  static _folderRecordsById() {
    return new Map(this._folderRecords().map(r => [r._id, r]));
  }

  static _journalRecords() {
    return game.journal.map(j => ({ _id: j.id, folder: j.folder?.id ?? null }));
  }

  static _isStampedRoot(folder) {
    return folder.getFlag('omnipresence', 'root') === true && SyncRegistry.isEnrolled(folder);
  }

  /** A marked root (flag), or a folder a player has queued for marking. */
  static isRoot(folder) {
    if (!folder) return false;
    if (this._isStampedRoot(folder)) return true;
    return this._pendingRootIdFor(folder) !== null;
  }

  /** The root id of a pending player mark for this folder, or null. */
  static _pendingRootIdFor(folder) {
    for (const user of game.users) {
      for (const [rootId, entry] of Object.entries(SyncRegistry.getPendingRoots(user.id))) {
        if (entry?.action === 'mark' && entry.folderId === folder.id) return rootId;
      }
    }
    return null;
  }

  /** The user whose pending-roots entry names this rootId, or null (used when a root has no ownerName flag, e.g. it only exists as a queued player mark). */
  static _pendingOwnerFor(rootId) {
    for (const user of game.users) {
      if (rootId in SyncRegistry.getPendingRoots(user.id)) return user;
    }
    return null;
  }

  /** The stamped root Folder a folder belongs to (itself included), or null. */
  static rootFor(folder) {
    let node = folder;
    while (node) {
      if (this._isStampedRoot(node)) return node;
      node = node.folder ?? null;
    }
    return null;
  }

  /** Root omni id for a journal's current folder chain, or null. */
  static rootIdForJournal(journal) {
    return findSyncedRootId(journal.folder?.id ?? null, this._folderRecordsById());
  }

  static findRootById(rootId) {
    return game.folders.find(f =>
      f.type === FOLDER_TYPE &&
      f.getFlag('omnipresence', 'id') === rootId &&
      f.getFlag('omnipresence', 'root') === true
    ) ?? null;
  }

  /** A root above or below `folder` (never `folder` itself), or null. */
  static nestedRoot(folder) {
    for (const a of folder.ancestors) if (this.isRoot(a)) return a;
    for (const d of folder.getSubfolders(true)) if (this.isRoot(d)) return d;
    return null;
  }

  /** Member journals of a folder's subtree (documents). */
  static members(folder) {
    const { journalIds } = collectFolderTree(folder.id, this._folderRecords(), this._journalRecords());
    return journalIds.map(id => game.journal.get(id)).filter(Boolean);
  }

  /** Subfolders of a folder's subtree, parents before children, root excluded. */
  static subfolders(folder) {
    const { folders } = collectFolderTree(folder.id, this._folderRecords(), this._journalRecords());
    return folders.slice(1).map(r => game.folders.get(r._id)).filter(Boolean);
  }

  /** May the current user mark this folder? GM: always. Player: owns every member, and there is at least one. */
  static canManage(folder) {
    if (game.user.isGM) return true;
    const members = this.members(folder);
    return members.length > 0 && members.every(j => j.isOwner);
  }

  /** May the current user unmark this root? GM: always. Player: their own root or their own pending mark. */
  static canUnmark(folder) {
    if (game.user.isGM) return true;
    if (folder.getFlag('omnipresence', 'ownerName') === game.user.name && this._isStampedRoot(folder)) return true;
    const pendingId = this._pendingRootIdFor(folder);
    return pendingId !== null && pendingId in SyncRegistry.getPendingRoots(game.user.id);
  }

  // --- allow-list seeding ---------------------------------------------------

  /** Roots this user is eligible for locally: GM → every root; player → roots whose ownerName is theirs. */
  static _eligibleLocalRootIds(userId) {
    const user = game.users.get(userId);
    if (!user) return [];
    const ids = [];
    for (const f of game.folders) {
      if (f.type !== FOLDER_TYPE || !this._isStampedRoot(f)) continue;
      const owner = f.getFlag('omnipresence', 'ownerName') ?? null;
      if (user.isGM || owner === user.name) ids.push(f.getFlag('omnipresence', 'id'));
    }
    return ids.filter(Boolean);
  }

  /**
   * An absent folderIds list means "all". Before the first explicit add or
   * remove, seed it with every root the user is already eligible for, so the
   * switch from "all" to "listed" never silently drops a syncing root.
   */
  static async _ensureFolderSelection(userId) {
    if (SyncRegistry.getSelection(userId).folderIds !== null) return;
    await SyncRegistry.setSelection(userId, { folderIds: this._eligibleLocalRootIds(userId) });
  }

  static async _setRegistry(rootId, on) {
    if (!game.user.isGM) return;
    const registry = SyncRegistry._getAll();
    if (on) registry[rootId] = true;
    else delete registry[rootId];
    await game.settings.set('omnipresence', SyncRegistry.SETTING, registry);
  }

  // --- mark / unmark --------------------------------------------------------

  /**
   * Mark a folder as a sync root. GM: stamp + push now. Player: enroll the
   * members (they own them) and queue the folder stamp for a GM, because
   * non-GM users cannot write Folder documents at all.
   * @returns {Promise<string|null>} the root id, or null when refused.
   */
  static async markFolder(folder) {
    if (this.isRoot(folder)) return null;
    const nested = this.nestedRoot(folder);
    if (nested) {
      ui.notifications.warn(game.i18n.format('OMNIPRESENCE.notifications.folderNested', { name: nested.name }));
      return null;
    }
    if (!this.canManage(folder)) return null;

    const rootId = foundry.utils.randomID(16);
    const ownerName = game.user.isGM ? null : game.user.name;
    await this._ensureFolderSelection(game.user.id);

    if (game.user.isGM) {
      await this._stamp(folder, rootId, ownerName);
      await SyncRegistry.addToSelection(game.user.id, 'folder', rootId);
      await this.pushFolder(folder);
      ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.enrolled', { name: folder.name }));
    } else {
      for (const journal of this.members(folder)) {
        await SyncRegistry.enroll(journal, { viaFolder: rootId });
      }
      await SyncRegistry.addToSelection(game.user.id, 'folder', rootId);
      await SyncRegistry.setPendingRoot(game.user.id, rootId, { folderId: folder.id, ownerName, action: 'mark' });
      ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.enrolledQueued', { name: folder.name }));
    }
    return rootId;
  }

  /** GM only: write root/subfolder flags, enroll members with viaFolder, register the root. */
  static async _stamp(folder, rootId, ownerName) {
    await folder.update({
      'flags.omnipresence.id': rootId,
      'flags.omnipresence.enrolled': true,
      'flags.omnipresence.root': true,
      'flags.omnipresence.ownerName': ownerName,
      'flags.omnipresence.-=rootId': null
    }, { omnipresenceInternal: true });
    for (const sub of this.subfolders(folder)) {
      const updates = { 'flags.omnipresence.rootId': rootId };
      if (!sub.getFlag('omnipresence', 'id')) updates['flags.omnipresence.id'] = foundry.utils.randomID(16);
      await sub.update(updates, { omnipresenceInternal: true });
    }
    for (const journal of this.members(folder)) {
      await SyncRegistry.enroll(journal, { viaFolder: rootId });
    }
    await this._setRegistry(rootId, true);
  }

  /**
   * Stop syncing a root. GM: clear flags, unenroll members, drop the pack
   * tree. Player: unenroll their members, withdraw consent, and queue the
   * unmark for a GM (a pending mark of theirs simply cancels). Local folders
   * and journals stay where they are in every case.
   */
  static async unmarkFolder(folder) {
    const rootId = folder.getFlag('omnipresence', 'id') ?? this._pendingRootIdFor(folder);
    if (!rootId) return;
    const ownerName = folder.getFlag('omnipresence', 'ownerName') ?? null;

    if (game.user.isGM) {
      this._cancelTimer(folder.id);
      await this._unstamp(folder, rootId);
      await this._deletePackTree(rootId);
      await this._ensureFolderSelection(game.user.id);
      await SyncRegistry.removeFromSelection(game.user.id, 'folder', rootId);
      // The marking player's consent entry is stale too (mirror of unenroll's owner cleanup).
      // A folder with no ownerName flag may still be a queued player mark (players can't
      // write Folder documents), so fall back to whoever's pendingRoots names this rootId.
      const owner = ownerName ? game.users.find(u => u.name === ownerName) : this._pendingOwnerFor(rootId);
      if (owner && owner.id !== game.user.id) {
        await this._ensureFolderSelection(owner.id);
        await SyncRegistry.removeFromSelection(owner.id, 'folder', rootId);
        await SyncRegistry.clearPendingRoot(owner.id, rootId);
      }
    } else {
      if (!this.canUnmark(folder)) return;
      const pending = SyncRegistry.getPendingRoots(game.user.id)[rootId];
      for (const journal of this.members(folder)) {
        if (journal.isOwner) await SyncRegistry.unenroll(journal);
      }
      await this._ensureFolderSelection(game.user.id);
      await SyncRegistry.removeFromSelection(game.user.id, 'folder', rootId);
      if (pending?.action === 'mark') {
        await SyncRegistry.clearPendingRoot(game.user.id, rootId);
      } else {
        await SyncRegistry.setPendingRoot(game.user.id, rootId, { folderId: folder.id, ownerName, action: 'unmark' });
      }
    }
    ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: folder.name }));
  }

  /** GM only: clear flags on root and subfolders, unenroll members, deregister. */
  static async _unstamp(folder, rootId) {
    for (const journal of this.members(folder)) {
      JournalSync.cancelFor(journal.id);
      await SyncRegistry.unenroll(journal);
    }
    for (const sub of this.subfolders(folder)) {
      await sub.update(
        { 'flags.omnipresence.-=id': null, 'flags.omnipresence.-=rootId': null },
        { omnipresenceInternal: true }
      );
    }
    await folder.update({
      'flags.omnipresence.-=id': null,
      'flags.omnipresence.-=enrolled': null,
      'flags.omnipresence.-=root': null,
      'flags.omnipresence.-=ownerName': null,
      'flags.omnipresence.-=syncedAt': null
    }, { omnipresenceInternal: true });
    await this._setRegistry(rootId, false);
  }

  /** Unenroll every local journal enrolled through `rootId` (used when a pending mark cannot be honoured). */
  static async _unenrollMembersOf(rootId) {
    for (const journal of game.journal.filter(j => j.getFlag('omnipresence', 'viaFolder') === rootId)) {
      JournalSync.cancelFor(journal.id);
      await SyncRegistry.unenroll(journal);
    }
  }

  // --- pack tree ------------------------------------------------------------

  static _nodeFromPackFolder(f) {
    const src = f._source;
    return {
      id: f.id,
      parentId: src.folder ?? null,
      name: src.name,
      color: src.color ?? null,
      sorting: src.sorting,
      sort: src.sort ?? 0
    };
  }

  /** Pack folders under (and including) a pack root as TreeNodes, parents first. */
  static _packTreeNodes(rootId) {
    const pack = this._getPack();
    if (!pack) return [];
    const byParent = new Map();
    for (const f of pack.folders) {
      const parent = f._source.folder ?? null;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(f);
    }
    const nodes = [];
    const queue = [pack.folders.get(rootId)].filter(Boolean);
    while (queue.length) {
      const f = queue.shift();
      nodes.push(this._nodeFromPackFolder(f));
      for (const child of byParent.get(f.id) ?? []) queue.push(child);
    }
    return nodes;
  }

  /**
   * The local subtree as TreeNodes keyed by omnipresence id. Subfolders not
   * yet stamped are skipped (stamping happens in _stamp / handleFolderCreate).
   * The root's parentId is always null: where the root sits is world-local.
   */
  static _localTreeNodes(root) {
    const rootId = root.getFlag('omnipresence', 'id');
    const { folders } = collectFolderTree(root.id, this._folderRecords(), this._journalRecords());
    const omniByLocal = new Map();
    for (const r of folders) {
      const omni = r.flags?.omnipresence?.id;
      if (omni) omniByLocal.set(r._id, omni);
    }
    return folders
      .filter(r => omniByLocal.has(r._id))
      .map(r => ({
        id: omniByLocal.get(r._id),
        parentId: r._id === root.id ? null : (omniByLocal.get(r.folder) ?? rootId),
        name: r.name,
        color: r.color ?? null,
        sorting: r.sorting,
        sort: r.sort ?? 0
      }));
  }

  static _packDataFromNode(node) {
    return {
      _id: node.id,
      name: node.name,
      type: FOLDER_TYPE,
      folder: node.parentId,
      color: node.color,
      sorting: node.sorting,
      sort: node.sort
    };
  }

  /** GM only: make the pack tree match the local subtree. */
  static async _syncPackTree(root, rootId) {
    const pack = this._getPack();
    const ownerName = root.getFlag('omnipresence', 'ownerName') ?? null;
    const { toCreate, toUpdate, toDelete } =
      diffFolderTree(this._localTreeNodes(root), this._packTreeNodes(rootId));
    for (const node of toCreate) {
      const data = this._packDataFromNode(node);
      if (node.id === rootId) data.flags = { omnipresence: { id: rootId, ownerName, tombstones: {} } };
      await this._FolderClass.create(data, { pack: this.PACK_ID, keepId: true, omnipresenceInternal: true });
    }
    for (const node of toUpdate) {
      const data = this._packDataFromNode(node);
      if (node.id === rootId) data['flags.omnipresence.ownerName'] = ownerName;
      await pack.folders.get(node.id)?.update(data, { omnipresenceInternal: true });
    }
    for (const id of toDelete) {
      await pack.folders.get(id)?.delete({ omnipresenceInternal: true });
    }
  }

  /** GM only: delete a root's pack folders and every pack journal inside them. */
  static async _deletePackTree(rootId) {
    const pack = this._getPack();
    if (!pack) return;
    const nodes = this._packTreeNodes(rootId);
    if (!nodes.length) return;
    const ids = new Set(nodes.map(n => n.id));
    for (const doc of await pack.getDocuments()) {
      if (ids.has(doc._source.folder)) await doc.delete({ omnipresenceInternal: true });
    }
    for (const node of [...nodes].reverse()) {
      await pack.folders.get(node.id)?.delete({ omnipresenceInternal: true });
    }
  }

  /**
   * Push a root: pack folder tree first, then every member through the
   * ordinary journal push (which sets the pack `folder` for viaFolder
   * journals). Stamps `syncedAt` on the root after the first success so a
   * root whose push never landed is pushed again at login instead of being
   * mistaken for an unsynced mirror.
   */
  static async pushFolder(root) {
    if (!game.user.isGM) return;
    if (!this._getPack()) {
      console.warn('Omnipresence | journals pack not found:', this.PACK_ID);
      return;
    }
    // A stale debounce timer must become a no-op, never a push: if the root was deleted
    // since the timer was set, its local subtree is now empty and would diff as "delete everything".
    if (!game.folders.get(root.id)) return;
    const rootId = root.getFlag('omnipresence', 'id');
    if (!rootId || !this._isStampedRoot(root)) return;
    try {
      await this._syncPackTree(root, rootId);
      for (const journal of this.members(root)) await JournalSync.push(journal);
      await root.update({ 'flags.omnipresence.syncedAt': new Date().toISOString() }, { omnipresenceInternal: true });
    } catch (err) {
      console.error('Omnipresence | folder push failed for', root.name, err);
      ui.notifications.warn(game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: root.name }));
    }
  }

  static debouncedPushFolder(root) {
    this._cancelTimer(root.id);
    const timer = setTimeout(() => {
      this._timers.delete(root.id);
      this.pushFolder(root);
    }, DEBOUNCE_MS);
    this._timers.set(root.id, timer);
  }

  static _cancelTimer(localId) {
    if (!this._timers.has(localId)) return;
    clearTimeout(this._timers.get(localId));
    this._timers.delete(localId);
  }

  /** Cancel (never flush) pending folder pushes — page unload, same rationale as JournalSync.cancelPending. */
  static cancelPending() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }
}
