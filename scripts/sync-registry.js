import { isEnrolledFrom } from './sync-logic.js';

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

  static async enroll(doc) {
    let id = doc.getFlag('omnipresence', 'id');
    // The owner-writable `enrolled` flag is the source of truth so non-GM owners
    // can enroll without the GM-only world-setting write.
    const updates = { 'flags.omnipresence.enrolled': true };
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
    return id;
  }

  static async unenroll(doc) {
    const id = doc.getFlag('omnipresence', 'id');
    if (!id) return;
    // Set the flag false so it wins over any stale legacy registry entry even
    // when a non-GM cannot clear the world registry.
    await doc.update({ 'flags.omnipresence.enrolled': false }, { omnipresenceInternal: true });
    if (game.user.isGM) {
      const registry = this._getAll();
      delete registry[id];
      await game.settings.set('omnipresence', this.SETTING, registry);
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

  static isActorSyncEnabled(userId) {
    return this.getPrefs(userId).actors !== false;
  }

  static isMacroSyncEnabled(userId) {
    return this.getPrefs(userId).macros !== false;
  }

  static isJournalSyncEnabled(userId) {
    return this.getPrefs(userId).journals !== false;
  }
}
