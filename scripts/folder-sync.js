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
    return this._setRegistryMany([rootId], on);
  }

  /** Add or remove several ids from the world registry in one settings write. */
  static async _setRegistryMany(ids, on) {
    if (!game.user.isGM) return;
    const registry = SyncRegistry._getAll();
    for (const id of ids) {
      if (on) registry[id] = true;
      else delete registry[id];
    }
    await game.settings.set('omnipresence', SyncRegistry.SETTING, registry);
  }

  /** Forget rootId from the acting user's and (if different) the owning user's folder allow-lists. */
  static async _forgetRootSelection(rootId, ownerName) {
    await this._ensureFolderSelection(game.user.id);
    await SyncRegistry.removeFromSelection(game.user.id, 'folder', rootId);
    const owner = ownerName ? game.users.find(u => u.name === ownerName) : this._pendingOwnerFor(rootId);
    if (owner && owner.id !== game.user.id) {
      await this._ensureFolderSelection(owner.id);
      await SyncRegistry.removeFromSelection(owner.id, 'folder', rootId);
    }
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
      await this._forgetRootSelection(rootId, ownerName);
      // The marking player's consent entry is stale too (mirror of unenroll's owner cleanup).
      // A folder with no ownerName flag may still be a queued player mark (players can't
      // write Folder documents), so fall back to whoever's pendingRoots names this rootId.
      const owner = ownerName ? game.users.find(u => u.name === ownerName) : this._pendingOwnerFor(rootId);
      if (owner && owner.id !== game.user.id) {
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

  // --- pending records (player marks/unmarks; GM drains them) -------------

  static _materializing = null;

  /**
   * GM only. Honour every user's pending folder marks and unmarks. A folder
   * that vanished or became nested since the player queued it cannot be
   * marked: its members are unenrolled instead. Non-reentrant: a login run
   * and an updateUser-triggered run join the same promise.
   */
  static async materializePending() {
    if (!game.user.isGM) return;
    if (this._materializing) return this._materializing;
    this._materializing = (async () => {
      for (const user of game.users) {
        const roots = SyncRegistry.getPendingRoots(user.id);
        for (const [rootId, entry] of Object.entries(roots)) {
          try {
            if (entry?.action === 'unmark') {
              const root = this.findRootById(rootId);
              if (root) await this.unmarkFolder(root);
              else await this._unenrollMembersOf(rootId);
            } else {
              const folder = game.folders.get(entry?.folderId);
              if (folder && folder.type === FOLDER_TYPE && !this._isStampedRoot(folder) && !this.nestedRoot(folder)) {
                await this._stamp(folder, rootId, entry.ownerName ?? user.name);
                await this.pushFolder(folder);
              } else if (!folder || !this._isStampedRoot(folder)) {
                await this._unenrollMembersOf(rootId);
              }
            }
            await SyncRegistry.clearPendingRoot(user.id, rootId);
          } catch (err) {
            console.error('Omnipresence | pending folder mark failed for', rootId, err);
          }
        }
        await this._materializeDeletes(user);
      }
      await this._materializeRemoves();
    })();
    try {
      await this._materializing;
    } finally {
      this._materializing = null;
    }
  }

  /** Deletes a player made with no GM connected. Entries that fail to materialize are kept for the next run. */
  static async _materializeDeletes(user) {
    const deletes = SyncRegistry.getPendingDeletes(user.id);
    if (!deletes.length) return;
    const docs = await this._getPack().getDocuments();
    const failed = [];
    for (const entry of deletes) {
      const { omniId, rootId } = entry;
      try {
        await this._removeFromPack(rootId, omniId, 'deleted', docs);
      } catch (err) {
        console.error('Omnipresence | pending folder delete failed for', omniId, err);
        failed.push(entry);
      }
    }
    if (failed.length) await SyncRegistry.setPendingDeletes(user.id, failed);
    else await SyncRegistry.clearPendingDeletes(user.id);
  }

  /** Move-outs a player made with no GM connected. */
  static async _materializeRemoves() {
    const pending = game.journal.filter(j => typeof j.getFlag('omnipresence', 'pendingRemove') === 'string');
    if (!pending.length) return;
    const docs = await this._getPack().getDocuments();
    for (const journal of pending) {
      try {
        const rootId = journal.getFlag('omnipresence', 'pendingRemove');
        await this._removeFromPack(rootId, journal.getFlag('omnipresence', 'id'), 'removed', docs);
        await journal.update({ 'flags.omnipresence.-=pendingRemove': null }, { omnipresenceInternal: true });
      } catch (err) {
        console.error('Omnipresence | pending folder remove failed for', journal.name, err);
      }
    }
  }

  // --- login reconcile (target-world side) ----------------------------------

  /**
   * Called from runLoginReconcile before JournalSync.onLogin so folders exist
   * and members are imported before the per-journal loop syncs content.
   */
  static async reconcileFolders() {
    const pack = this._getPack();
    if (!pack) return;
    if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return;

    await this.materializePending();

    const compDocs = await pack.getDocuments();
    const seenRootIds = new Set();

    for (const packRoot of pack.folders.filter(f => !f._source.folder)) {
      const rootId = packRoot.id;
      seenRootIds.add(rootId);
      try {
        // 1. Gate on the owning user's preference and folder allow-list.
        const ownerName = packRoot.getFlag('omnipresence', 'ownerName') ?? null;
        const gateUser = SyncRegistry.folderGateUser(ownerName);
        if (!gateUser) continue;
        if (!SyncRegistry.isJournalSyncEnabled(gateUser.id)) continue;
        if (!SyncRegistry.isDocSelected(gateUser.id, 'folder', rootId)) continue;

        let root = this.findRootById(rootId);

        // 4. The source deleted the root with its contents: mirror the delete.
        if (packRoot.getFlag('omnipresence', 'deleted') === true) {
          if (root && game.user.isGM) await this._deleteLocalRoot(root, rootId);
          continue;
        }

        if (!game.user.isGM) continue; // players cannot create or edit folders

        // 2. / 3. Import the tree, or make the local tree match the pack.
        if (!root) root = await this._importTree(packRoot, rootId, ownerName);
        else await this._applyTree(root, rootId);

        // 6. Members.
        await this._reconcileMembers(root, rootId, packRoot, compDocs);
      } catch (err) {
        console.error('Omnipresence | folder reconcile failed for', packRoot.name, err);
      }
    }

    // 5. Local roots with no pack folder: the source unsynced them → unmark
    // the mirror, keep the copies. A root that never synced (push failed, or
    // marked while the pack was unavailable) is pushed instead.
    if (!game.user.isGM) return;
    for (const root of game.folders.filter(f => f.type === FOLDER_TYPE && this._isStampedRoot(f))) {
      const rootId = root.getFlag('omnipresence', 'id');
      if (seenRootIds.has(rootId)) continue;
      try {
        if (!root.getFlag('omnipresence', 'syncedAt')) {
          await this.pushFolder(root);
        } else {
          const ownerName = root.getFlag('omnipresence', 'ownerName') ?? null;
          await this._unstamp(root, rootId);
          await this._forgetRootSelection(rootId, ownerName);
        }
      } catch (err) {
        console.error('Omnipresence | folder reconcile failed for local root', root.name, err);
      }
    }
  }

  /** Create the root at the top level plus its subfolders, stamped, and register it. */
  static async _importTree(packRoot, rootId, ownerName) {
    const nodes = this._packTreeNodes(rootId); // parents first
    const localByOmni = new Map();
    for (const node of nodes) {
      const isRoot = node.id === rootId;
      const flags = isRoot
        ? { omnipresence: { id: rootId, enrolled: true, root: true, ownerName, syncedAt: new Date().toISOString() } }
        : { omnipresence: { id: node.id, rootId } };
      const created = await this._FolderClass.create({
        name: node.name,
        type: FOLDER_TYPE,
        color: node.color,
        sorting: node.sorting,
        sort: node.sort,
        folder: isRoot ? null : (localByOmni.get(node.parentId) ?? localByOmni.get(rootId)),
        flags
      }, { omnipresenceInternal: true });
      localByOmni.set(node.id, created.id);
    }
    await this._setRegistry(rootId, true);
    return game.folders.get(localByOmni.get(rootId));
  }

  static _localFoldersByOmni() {
    const map = new Map();
    for (const f of game.folders) {
      if (f.type !== FOLDER_TYPE) continue;
      const id = f.getFlag('omnipresence', 'id');
      if (id) map.set(id, f);
    }
    return map;
  }

  /**
   * Pack → local tree apply. Pack wins for name/colour/sorting/sort and for
   * subfolder placement; the root's own placement is world-local. Local
   * subfolders gone from the pack are deleted; anything still inside them
   * is moved to the root first (members are reconciled right after, where
   * tombstones decide their fate), never deleted here.
   */
  static async _applyTree(root, rootId) {
    const { toCreate, toUpdate, toDelete } =
      diffFolderTree(this._packTreeNodes(rootId), this._localTreeNodes(root));
    for (const node of toCreate) {
      if (node.id === rootId) continue;
      const local = this._localFoldersByOmni();
      await this._FolderClass.create({
        name: node.name,
        type: FOLDER_TYPE,
        color: node.color,
        sorting: node.sorting,
        sort: node.sort,
        folder: (local.get(node.parentId) ?? root).id,
        flags: { omnipresence: { id: node.id, rootId } }
      }, { omnipresenceInternal: true });
    }
    for (const node of toUpdate) {
      const local = this._localFoldersByOmni();
      const target = local.get(node.id);
      if (!target) continue;
      const data = { name: node.name, color: node.color, sorting: node.sorting, sort: node.sort };
      if (node.id !== rootId) data.folder = (local.get(node.parentId) ?? root).id;
      await target.update(data, { omnipresenceInternal: true });
    }
    for (const id of toDelete) {
      const target = this._localFoldersByOmni().get(id);
      if (!target || target.id === root.id) continue;
      for (const j of target.contents) await j.update({ folder: root.id }, { omnipresenceInternal: true });
      await target.delete({ omnipresenceInternal: true });
    }
  }

  /**
   * Members of one root. Pack members: re-attach or place a local copy
   * (matched by omnipresence id), or import it. Local viaFolder journals
   * with no pack copy: tombstone decides — delete, detach, or push.
   */
  static async _reconcileMembers(root, rootId, packRoot, compDocs) {
    const packFolderIds = new Set(this._packTreeNodes(rootId).map(n => n.id));
    const localFolders = this._localFoldersByOmni();
    const localByOmni = new Map();
    for (const j of game.journal) {
      const id = j.getFlag('omnipresence', 'id');
      if (id) localByOmni.set(id, j);
    }

    const packMemberIds = new Set();
    for (const comp of compDocs) {
      if (!packFolderIds.has(comp._source.folder)) continue;
      const omniId = comp.getFlag('omnipresence', 'id');
      if (!omniId) continue;
      packMemberIds.add(omniId);
      const targetFolder = localFolders.get(comp._source.folder) ?? root;
      try {
        const local = localByOmni.get(omniId);
        if (local) {
          if (local.getFlag('omnipresence', 'viaFolder') !== rootId || local.getFlag('omnipresence', 'enrolled') !== true) {
            await SyncRegistry.enroll(local, { viaFolder: rootId });
          }
          if (local.folder?.id !== targetFolder.id) {
            await local.update({ folder: targetFolder.id }, { omnipresenceInternal: true });
          }
        } else {
          await this._importMember(comp, targetFolder, rootId);
        }
      } catch (err) {
        console.error('Omnipresence | folder member reconcile failed for', comp.name, err);
      }
    }

    const tombstones = packRoot.getFlag('omnipresence', 'tombstones');
    for (const journal of game.journal.filter(j => j.getFlag('omnipresence', 'viaFolder') === rootId)) {
      const omniId = journal.getFlag('omnipresence', 'id');
      if (!omniId || packMemberIds.has(omniId)) continue;
      try {
        // A re-entry recorded with no GM connected must be pushed even when a
        // stale `removed` tombstone still names this journal — the push path
        // below prunes the tombstone once it lands.
        const action = journal.getFlag('omnipresence', 'pendingEnter') === rootId
          ? 'push'
          : resolveTombstoneAction(tombstones, omniId);
        if (action === 'delete') await journal.delete({ omnipresenceInternal: true });
        else if (action === 'detach') await this._detach(journal);
        else await JournalSync.push(journal);
      } catch (err) {
        console.error('Omnipresence | folder member tombstone handling failed for', journal.name, err);
      }
    }
  }

  /**
   * Import one pack member. Ownership follows the spec's table: a member with
   * a player ownerName imports only where that player exists (skipped and
   * retried next login otherwise); a member with no player owner imports
   * GM-owned — the GM marking the folder is the consent.
   */
  static async _importMember(comp, targetFolder, rootId) {
    const memberOwnerName = comp.getFlag('omnipresence', 'ownerName') ?? null;
    let ownership = { default: 0 };
    if (memberOwnerName) {
      const owner = game.users.find(u => u.name === memberOwnerName);
      if (!owner) {
        console.warn('Omnipresence | no user named', memberOwnerName, '— skipping folder member', comp.name);
        return null;
      }
      ownership = { default: 0, [owner.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
    }
    const { journalData, pins } = JournalSync.prepareImportData(comp);
    journalData.folder = targetFolder.id;
    journalData.ownership = ownership;
    const created = await JournalEntry.create(journalData, { keepId: true, omnipresenceInternal: true });
    await SyncRegistry.enroll(created, { viaFolder: rootId });
    if (pins !== undefined) await JournalSync._applyPins(created, pins);
    return created;
  }

  /** The source moved a member out: unenroll here and move it to the directory root, keeping the copy. */
  static async _detach(journal) {
    JournalSync.cancelFor(journal.id);
    await SyncRegistry.unenroll(journal);
    if (journal.folder) await journal.update({ folder: null }, { omnipresenceInternal: true });
  }

  /** The source deleted the root with its contents: delete the mirror. */
  static async _deleteLocalRoot(root, rootId) {
    this._cancelTimer(root.id);
    const ownerName = root.getFlag('omnipresence', 'ownerName') ?? null;
    const members = this.members(root);
    const memberIds = members.map(j => j.getFlag('omnipresence', 'id')).filter(Boolean);
    for (const j of members) {
      JournalSync.cancelFor(j.id);
      await j.delete({ omnipresenceInternal: true });
    }
    for (const sub of this.subfolders(root).reverse()) await sub.delete({ omnipresenceInternal: true });
    await root.delete({ omnipresenceInternal: true });
    await this._setRegistryMany([rootId, ...memberIds], false);
    await this._forgetRootSelection(rootId, ownerName);
  }

  /** Dashboard "force pull": pack wins for tree and every member's content. */
  static async pullFolder(root) {
    if (!game.user.isGM) return;
    const pack = this._getPack();
    if (!pack) return;
    const rootId = root.getFlag('omnipresence', 'id');
    const packRoot = pack.folders.get(rootId);
    if (!packRoot) return;
    const compDocs = await pack.getDocuments();
    await this._applyTree(root, rootId);
    await this._reconcileMembers(root, rootId, packRoot, compDocs);
    for (const journal of this.members(root)) {
      const omniId = journal.getFlag('omnipresence', 'id');
      const comp = compDocs.find(d => d.getFlag('omnipresence', 'id') === omniId);
      if (comp) await JournalSync.pull(journal, comp);
    }
  }

  // --- membership hooks (source-world side) --------------------------------

  /**
   * Every client sees every hook. Membership writes are done by ONE client:
   * the connected GM when there is one (it can write any document and the
   * pack), otherwise the acting user's own client (its own journals and its
   * own User document only — a GM finishes the pack side later).
   */
  static _isResponsible(userId) {
    const gm = game.users.activeGM;
    return gm ? game.user.id === gm.id : game.user.id === userId;
  }

  static async handleMemberCreate(journal, options, userId) {
    if (options?.omnipresenceInternal || journal.pack) return;
    if (!this._isResponsible(userId) || !journal.isOwner) return;
    const rootId = this.rootIdForJournal(journal);
    if (!rootId) return;
    await this._enter(journal, rootId);
  }

  /** updateJournalEntry with a `folder` change: classify against viaFolder. */
  static async handleMemberMove(journal, changes, options, userId) {
    if (options?.omnipresenceInternal || journal.pack) return;
    if (!('folder' in changes)) return;
    if (!this._isResponsible(userId) || !journal.isOwner) return;
    const viaFolder = journal.getFlag('omnipresence', 'viaFolder') ?? null;
    const rootId = this.rootIdForJournal(journal);
    switch (classifyMembership({ viaFolder, rootId })) {
      case 'enter':
        await this._enter(journal, rootId);
        break;
      case 'leave':
        await this._leave(journal, viaFolder);
        break;
      case 'switch':
        await this._leave(journal, viaFolder);
        await this._enter(journal, rootId);
        break;
      // 'stay': moved between subfolders of the same root. The generic
      // updateJournalEntry hook already scheduled a push (the journal is
      // enrolled), which re-writes the pack `folder`.
      default:
        break;
    }
  }

  static async handleMemberDelete(journal, options, userId) {
    if (options?.omnipresenceInternal || journal.pack) return;
    const rootId = journal.getFlag('omnipresence', 'viaFolder');
    if (!rootId) return;
    if (!this._isResponsible(userId)) return;
    JournalSync.cancelFor(journal.id);
    const omniId = journal.getFlag('omnipresence', 'id');
    if (game.user.isGM) await this._removeFromPack(rootId, omniId, 'deleted');
    else await SyncRegistry.addPendingDelete(game.user.id, { omniId, rootId });
  }

  static async _enter(journal, rootId) {
    await SyncRegistry.enroll(journal, { viaFolder: rootId });
    if (game.user.isGM) {
      JournalSync.debouncedPush(journal);
    } else {
      // No GM connected: record the re-entry so the GM's next login pushes
      // this journal even if a stale `removed` tombstone still names it
      // (it may have left and come back before the GM ever saw the leave).
      await journal.update({ 'flags.omnipresence.pendingEnter': rootId }, { omnipresenceInternal: true });
    }
  }

  /**
   * Leave: unenroll locally; the GM also drops the pack copy and tombstones
   * it as `removed`. A player (no GM connected) records `pendingRemove` so
   * the GM's login can tell this from a detached mirror copy elsewhere.
   */
  static async _leave(journal, rootId) {
    JournalSync.cancelFor(journal.id);
    await SyncRegistry.unenroll(journal);
    if (game.user.isGM) {
      await this._removeFromPack(rootId, journal.getFlag('omnipresence', 'id'), 'removed');
    } else {
      await journal.update({ 'flags.omnipresence.pendingRemove': rootId }, { omnipresenceInternal: true });
    }
  }

  /** GM: delete a member's pack copy and record why on the root pack folder. Idempotent. */
  static async _removeFromPack(rootId, omniId, reason, docs = null) {
    const pack = this._getPack();
    if (!pack || !omniId) return;
    const all = docs ?? await pack.getDocuments();
    const comp = all.find(d => d.getFlag('omnipresence', 'id') === omniId);
    if (comp) {
      // "Delete All" fires this both from the member's own delete hook and
      // from the root's delete handler; the second delete finds a stale doc.
      try {
        await comp.delete({ omnipresenceInternal: true });
      } catch (err) {
        console.warn('Omnipresence | pack copy already removed for', omniId, err);
      }
    }
    const packRoot = pack.folders.get(rootId);
    if (!packRoot) return;
    await packRoot.update(
      { [`flags.omnipresence.tombstones.${omniId}`]: { reason, at: new Date().toISOString() } },
      { omnipresenceInternal: true }
    );
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

  // --- folder hooks (source-world side; folder writes are GM/Assistant only) -

  static _preDelete = new Map(); // folder local id → capture from preDeleteFolder

  static async handleFolderCreate(folder, options, _userId) {
    if (options?.omnipresenceInternal || folder.pack || folder.type !== FOLDER_TYPE) return;
    if (!game.user.isGM) return;
    const root = folder.folder ? this.rootFor(folder.folder) : null;
    if (!root) return;
    await folder.update({
      'flags.omnipresence.id': foundry.utils.randomID(16),
      'flags.omnipresence.rootId': root.getFlag('omnipresence', 'id')
    }, { omnipresenceInternal: true });
    this.debouncedPushFolder(root);
  }

  /**
   * Rename / recolour / reorder: push the owning root. Reparent: if the
   * subtree left its root, its members leave and its stamps are cleared;
   * if it entered a root (from outside, or straight from another root),
   * it is stamped and its members enter.
   */
  static async handleFolderUpdate(folder, changes, options, _userId) {
    if (options?.omnipresenceInternal || folder.pack || folder.type !== FOLDER_TYPE) return;
    if (!game.user.isGM) return;

    if (this._isStampedRoot(folder)) {
      // A root's own placement is world-local; name/colour/sort still sync.
      this.debouncedPushFolder(folder);
      return;
    }

    const stampedRootId = folder.getFlag('omnipresence', 'rootId') ?? null;
    const currentRoot = folder.folder ? this.rootFor(folder.folder) : null;
    const currentRootId = currentRoot?.getFlag('omnipresence', 'id') ?? null;

    if ('folder' in changes && stampedRootId !== currentRootId) {
      if (stampedRootId) {
        await this._subtreeLeft(folder, stampedRootId);
        const oldRoot = this.findRootById(stampedRootId);
        if (oldRoot) this.debouncedPushFolder(oldRoot);
      }
      if (currentRoot) await this._subtreeEntered(folder, currentRoot);
      return;
    }
    if (currentRoot) this.debouncedPushFolder(currentRoot);
  }

  /** A subtree was dragged out of its root: members leave, subfolder stamps clear. */
  static async _subtreeLeft(folder, rootId) {
    const { folders, journalIds } = collectFolderTree(folder.id, this._folderRecords(), this._journalRecords());
    for (const id of journalIds) {
      const j = game.journal.get(id);
      if (j?.getFlag('omnipresence', 'viaFolder') === rootId) await this._leave(j, rootId);
    }
    for (const r of folders) {
      await game.folders.get(r._id)?.update(
        { 'flags.omnipresence.-=id': null, 'flags.omnipresence.-=rootId': null },
        { omnipresenceInternal: true }
      );
    }
  }

  /** A subtree was dragged into a root: stamp every folder, members enter, push. */
  static async _subtreeEntered(folder, root) {
    const rootId = root.getFlag('omnipresence', 'id');
    const { folders, journalIds } = collectFolderTree(folder.id, this._folderRecords(), this._journalRecords());
    for (const r of folders) {
      const f = game.folders.get(r._id);
      if (!f) continue;
      const updates = { 'flags.omnipresence.rootId': rootId };
      if (!f.getFlag('omnipresence', 'id')) updates['flags.omnipresence.id'] = foundry.utils.randomID(16);
      await f.update(updates, { omnipresenceInternal: true });
    }
    for (const id of journalIds) {
      const j = game.journal.get(id);
      if (j && j.getFlag('omnipresence', 'viaFolder') !== rootId) await this._enter(j, rootId);
    }
    this.debouncedPushFolder(root);
  }

  /**
   * preDeleteFolder: remember what is about to vanish. By the time
   * deleteFolder fires, contents are already deleted or moved and the
   * subtree cannot be walked, so capture root, members, and the delete
   * options here.
   */
  static capturePreDelete(folder, options, _userId) {
    if (folder.pack || folder.type !== FOLDER_TYPE) return;
    const isRoot = this._isStampedRoot(folder);
    const root = isRoot ? folder : (folder.folder ? this.rootFor(folder.folder) : null);
    if (!root) return;
    const { journalIds } = collectFolderTree(folder.id, this._folderRecords(), this._journalRecords());
    this._preDelete.set(folder.id, {
      isRoot,
      rootId: root.getFlag('omnipresence', 'id'),
      rootLocalId: root.id,
      ownerName: root.getFlag('omnipresence', 'ownerName') ?? null,
      deleteContents: options?.deleteContents === true,
      members: journalIds
        .map(id => game.journal.get(id))
        .filter(Boolean)
        .map(j => ({ id: j.id, omniId: j.getFlag('omnipresence', 'id') }))
    });
  }

  static async handleFolderDelete(folder, options, _userId) {
    const captured = this._preDelete.get(folder.id);
    this._preDelete.delete(folder.id);
    if (options?.omnipresenceInternal || folder.pack) return;
    if (!captured || !game.user.isGM) return;
    const { isRoot, rootId, rootLocalId, ownerName, deleteContents, members } = captured;
    const pack = this._getPack();
    if (!pack) return;

    if (!isRoot) {
      // Subfolder gone. Its members fired their own delete/move hooks; the
      // tree push drops the pack folder.
      const root = game.folders.get(rootLocalId);
      if (root) this.debouncedPushFolder(root);
      return;
    }

    this._cancelTimer(rootLocalId);
    if (deleteContents) {
      // "Delete All": members' delete hooks already tombstoned them, but the
      // capture makes this independent of hook order (idempotent). Keep the
      // root pack folder, emptied and flagged, so mirrors delete themselves.
      const docs = await pack.getDocuments();
      for (const { omniId } of members) {
        if (omniId) await this._removeFromPack(rootId, omniId, 'deleted', docs);
      }
      for (const node of [...this._packTreeNodes(rootId)].reverse()) {
        if (node.id !== rootId) await pack.folders.get(node.id)?.delete({ omnipresenceInternal: true });
      }
      await pack.folders.get(rootId)?.update({ 'flags.omnipresence.deleted': true }, { omnipresenceInternal: true });
    } else {
      // "Remove Folder": contents moved up = unmark. Members that already
      // fired `leave` are unenrolled; make sure the rest are too, then drop
      // the pack tree so mirrors detach (keep copies) at their next login.
      for (const { id } of members) {
        const j = game.journal.get(id);
        if (j && SyncRegistry.isEnrolled(j)) {
          JournalSync.cancelFor(j.id);
          await SyncRegistry.unenroll(j);
        }
      }
      await this._deletePackTree(rootId);
    }
    await this._setRegistry(rootId, false);
    await this._forgetRootSelection(rootId, ownerName);
  }
}
