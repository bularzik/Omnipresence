import { isEnrolledFrom, isSelected, isFolderSelected, isGateUser } from './sync-logic.js';

export class SyncRegistry {
  static SETTING = 'syncRegistry';
  static register() {
    game.settings.register('omnipresence', this.SETTING, {
      name: 'Sync Registry',
      scope: 'world',
      config: false,
      type: Object,
      default: {}
    });
  }

  static _getAll() {
    return game.settings.get('omnipresence', this.SETTING);
  }

  static isEnrolled(doc) {
    const id = doc.getFlag('omnipresence', 'id');
    const enrolledFlag = doc.getFlag('omnipresence', 'enrolled');
    const inRegistry = id ? id in this._getAll() : false;
    return isEnrolledFrom({ id, enrolledFlag, inRegistry });
  }

  static getEnrolledIds() {
    return Object.keys(this._getAll());
  }

  /** Returns the owner name to store in flags (non-GM owner, or null). */
  static resolveOwnerName(actor) {
    for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
      if (userId === 'default') continue;
      if (level < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) continue;
      const user = game.users.get(userId);
      if (user && !user.isGM) return user.name;
    }
    if (actor.isOwner && !game.user.isGM) return game.user.name;
    return null;
  }

  static async enroll(doc, { viaFolder = null } = {}) {
    let id = doc.getFlag('omnipresence', 'id');
    // The owner-writable `enrolled` flag is the source of truth so non-GM owners
    // can enroll without the GM-only world-setting write.
    const updates = { 'flags.omnipresence.enrolled': true };
    if (viaFolder) {
      // Enrolled through a synced folder: the folder gates it, not journalIds.
      // Remember an individual enrollment so unmarking the folder can restore
      // it (unenrollMember) instead of dropping the journal from sync.
      if (doc.getFlag('omnipresence', 'enrolled') === true && !doc.getFlag('omnipresence', 'viaFolder')) {
        updates['flags.omnipresence.wasIndividual'] = true;
      }
      updates['flags.omnipresence.viaFolder'] = viaFolder;
      updates['flags.omnipresence.pendingRemove'] = null;
      updates['flags.omnipresence.pendingEnter'] = null;
    }
    if (!id) {
      id = foundry.utils.randomID(16);
      const now = new Date().toISOString();
      updates['flags.omnipresence.id'] = id;
      updates['flags.omnipresence.ownerName'] = this.resolveOwnerName(doc);
      updates['flags.omnipresence.syncedAt'] = now;
      updates['flags.omnipresence.localModifiedAt'] = now;
    }
    await doc.update(updates, { omnipresenceInternal: true });
    // Keep the legacy world registry in sync when permitted (GM only).
    if (game.user.isGM) {
      const registry = this._getAll();
      registry[id] = true;
      await game.settings.set('omnipresence', this.SETTING, registry);
    }
    // Consent lives on the GATE user's per-world allow-list: the user named by
    // the doc's ownerName, or the GM for a GM-owned doc (see isGateUser). The
    // acting user is usually the gate user; a GM enrolling a player's doc adds
    // it to that player's list (a GM may write any user's flags) so the
    // player's own gate admits it. Auto-imports of another user's doc run
    // under the GM and are already on the owner's list, so nothing lands on
    // the GM's list any more (it used to grow one orphan per import).
    // A folder member is gated by its root's folderIds entry instead, so its
    // own id is removed from the list if it was ever enrolled individually.
    const gateUser = this.gateUser(doc.getFlag('omnipresence', 'ownerName') ?? null);
    if (gateUser && (gateUser.id === game.user.id || game.user.isGM)) {
      const kind = doc.documentName === 'JournalEntry' ? 'journal' : 'actor';
      if (viaFolder) await this.removeFromSelection(gateUser.id, kind, id);
      else await this.addToSelection(gateUser.id, kind, id);
    }
    return id;
  }

  static async unenroll(doc) {
    const id = doc.getFlag('omnipresence', 'id');
    if (!id) return;
    // Set the flag false so it wins over any stale legacy registry entry even
    // when a non-GM cannot clear the world registry.
    await doc.update(
      { 'flags.omnipresence.enrolled': false, 'flags.omnipresence.viaFolder': null, 'flags.omnipresence.-=wasIndividual': null },
      { omnipresenceInternal: true }
    );
    if (game.user.isGM) {
      const registry = this._getAll();
      delete registry[id];
      await game.settings.set('omnipresence', this.SETTING, registry);
    }
    const kind = doc.documentName === 'JournalEntry' ? 'journal' : 'actor';
    // Mirror of enroll's addToSelection. Leaving the id in the allow-list makes
    // onLogin's auto-import — which keys off ENROLLED docs only — re-create the
    // doc from its pack copy as a duplicate at the next GM login.
    if (doc.isOwner) {
      await this.removeFromSelection(game.user.id, kind, id);
    }
    // GMs have doc.isOwner === true on every document by role, so the removal
    // above only clears the ACTING user's list. But onLogin's auto-import gates
    // on the OWNING user's allow-list (resolved from the doc's ownerName flag),
    // not the acting user's — so when a GM unenrolls another player's doc (every
    // context-menu/dashboard unenroll path allows this), the owning player's
    // allow-list entry must also be cleared, or the duplicate-reimport defect
    // above still reproduces for that player at their next login. Only a GM can
    // write another user's flags, hence the isGM guard; skip when the resolved
    // owner is the acting user (already handled above) or ownerName is absent/
    // unresolvable.
    if (game.user.isGM) {
      const ownerName = doc.getFlag('omnipresence', 'ownerName');
      const owner = ownerName ? game.users.find(u => u.name === ownerName) : null;
      if (owner && owner.id !== game.user.id) {
        await this.removeFromSelection(owner.id, kind, id);
      }
    }
  }

  /**
   * A folder member leaves its folder's sync (unmark, move-out, detach). A
   * journal that was individually enrolled before the folder took it over
   * goes back to individual enrollment — and back onto its owner's journal
   * allow-list — instead of leaving sync altogether. Anything else unenrolls.
   */
  static async unenrollMember(doc) {
    if (doc.getFlag('omnipresence', 'wasIndividual') !== true) return this.unenroll(doc);
    await doc.update({
      'flags.omnipresence.viaFolder': null,
      'flags.omnipresence.-=wasIndividual': null,
      'flags.omnipresence.-=pendingRemove': null,
      'flags.omnipresence.-=pendingEnter': null
    }, { omnipresenceInternal: true });
    const id = doc.getFlag('omnipresence', 'id');
    const gateUser = this.gateUser(doc.getFlag('omnipresence', 'ownerName') ?? null);
    if (id && gateUser && (gateUser.id === game.user.id || game.user.isGM)) {
      await this.addToSelection(gateUser.id, 'journal', id);
    }
  }

  // Per-user sync preferences live on the User document as flags so that:
  // - each user can write their own flags without GM permission, and
  // - the GM can read any user's flags since User documents sync to all clients.
  static getPrefs(userId) {
    const user = game.users?.get(userId);
    if (!user) return { actors: true, macros: true, journals: true };
    const stored = user.getFlag('omnipresence', 'prefs') ?? {};
    return {
      actors: stored.actors !== false,
      macros: stored.macros !== false,
      journals: stored.journals !== false
    };
  }

  static async setPrefs(userId, prefs) {
    const user = game.users?.get(userId);
    if (!user) return;
    const existing = user.getFlag('omnipresence', 'prefs') ?? {};
    await user.setFlag('omnipresence', 'prefs', { ...existing, ...prefs });
  }

  // --- First-sync consent (per-world User flags) ---------------------------

  static isOnboarded(userId) {
    const user = game.users?.get(userId);
    return !!user?.getFlag('omnipresence', 'onboarded');
  }

  static async setOnboarded(userId) {
    const user = game.users?.get(userId);
    if (!user) return;
    await user.setFlag('omnipresence', 'onboarded', true);
  }

  // Per-world, per-user allow-list of omnipresence ids permitted to sync into
  // this world. Actors/journals: a doc syncs only if its category pref is on
  // AND its id is here. Folders: an ABSENT list (null) means "every root the
  // user is eligible for" — it is seeded the first time something writes it.
  static getSelection(userId) {
    const user = game.users?.get(userId);
    const stored = user?.getFlag('omnipresence', 'selection') ?? {};
    return {
      actorIds: Array.isArray(stored.actorIds) ? stored.actorIds : [],
      journalIds: Array.isArray(stored.journalIds) ? stored.journalIds : [],
      folderIds: Array.isArray(stored.folderIds) ? stored.folderIds : null
    };
  }

  static async setSelection(userId, partial) {
    const user = game.users?.get(userId);
    if (!user) return;
    const existing = user.getFlag('omnipresence', 'selection') ?? {};
    await user.setFlag('omnipresence', 'selection', { ...existing, ...partial });
  }

  static _selectionKey(kind) {
    return { actor: 'actorIds', journal: 'journalIds', folder: 'folderIds' }[kind];
  }

  static isDocSelected(userId, kind, id) {
    const sel = this.getSelection(userId);
    if (kind === 'folder') return isFolderSelected(id, sel.folderIds);
    return isSelected(id, sel[this._selectionKey(kind)]);
  }

  static async addToSelection(userId, kind, id) {
    if (!id) return;
    const sel = this.getSelection(userId);
    const key = this._selectionKey(kind);
    const list = sel[key] ?? [];
    if (list.includes(id)) return;
    await this.setSelection(userId, { [key]: [...list, id] });
  }

  static async removeFromSelection(userId, kind, id) {
    if (!id) return;
    const sel = this.getSelection(userId);
    const key = this._selectionKey(kind);
    const list = sel[key] ?? [];
    if (!list.includes(id)) return;
    await this.setSelection(userId, { [key]: list.filter(x => x !== id) });
  }

  static isActorSyncEnabled(userId) {
    return this.getPrefs(userId).actors !== false;
  }

  static isMacroSyncEnabled(userId) {
    return this.getPrefs(userId).macros !== false;
  }

  static isJournalSyncEnabled(userId) {
    return this.getPrefs(userId).journals !== false;
  }

  // --- Folder sync: player-side pending records ---------------------------
  // Players cannot write Folder documents, so a player's folder mark/unmark and
  // a player's delete of a folder member (with no GM connected) are recorded
  // on their own User document and drained by a GM (FolderSync.materializePending).
  // Writes deliberately omit omnipresenceInternal: the GM's updateUser hook is
  // what notices a new pending entry while a GM is connected.

  static getPendingRoots(userId) {
    const stored = game.users?.get(userId)?.getFlag('omnipresence', 'pendingRoots');
    return stored && typeof stored === 'object' ? stored : {};
  }

  static async setPendingRoot(userId, rootId, entry) {
    const user = game.users?.get(userId);
    if (!user) return;
    await user.update({ [`flags.omnipresence.pendingRoots.${rootId}`]: entry });
  }

  static async clearPendingRoot(userId, rootId) {
    const user = game.users?.get(userId);
    if (!user) return;
    await user.update({ [`flags.omnipresence.pendingRoots.-=${rootId}`]: null }, { omnipresenceInternal: true });
  }

  static getPendingDeletes(userId) {
    const stored = game.users?.get(userId)?.getFlag('omnipresence', 'pendingDeletes');
    return Array.isArray(stored) ? stored : [];
  }

  static async addPendingDelete(userId, entry) {
    const user = game.users?.get(userId);
    if (!user) return;
    await user.update({ 'flags.omnipresence.pendingDeletes': [...this.getPendingDeletes(userId), entry] });
  }

  static async clearPendingDeletes(userId) {
    const user = game.users?.get(userId);
    if (!user) return;
    await user.update({ 'flags.omnipresence.pendingDeletes': [] }, { omnipresenceInternal: true });
  }

  /** Replace a user's pending-deletes list wholesale (e.g. keeping only entries that failed to materialize). */
  static async setPendingDeletes(userId, entries) {
    const user = game.users?.get(userId);
    if (!user) return;
    await user.update({ 'flags.omnipresence.pendingDeletes': entries }, { omnipresenceInternal: true });
  }

  /**
   * The user whose preferences and allow-list gate a document or root: the
   * user named by its ownerName, or — for a GM-owned doc / GM-marked root
   * (null) — the current user when they are a GM. Null when nobody here can
   * gate it (the named user does not exist in this world).
   */
  static gateUser(ownerName) {
    if (ownerName) return game.users.find(u => u.name === ownerName) ?? null;
    return game.user.isGM ? game.user : null;
  }

  /** @deprecated alias kept for the folder-sync call sites; same rule as gateUser. */
  static folderGateUser(ownerName) {
    return this.gateUser(ownerName);
  }

  /** Whether the current user is the gate user for `doc` (see sync-logic isGateUser). */
  static isGateUserFor(doc) {
    return isGateUser({
      ownerName: doc.getFlag('omnipresence', 'ownerName') ?? null,
      isGM: game.user.isGM,
      userName: game.user.name
    });
  }
}
