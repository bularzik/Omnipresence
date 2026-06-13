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

  static isEnrolled(actor) {
    const id = actor.getFlag('omnipresence', 'id');
    if (!id) return false;
    return id in this._getAll();
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

  static async enroll(actor) {
    let id = actor.getFlag('omnipresence', 'id');
    if (!id) {
      id = foundry.utils.randomID(16);
      const ownerName = this.resolveOwnerName(actor);
      const now = new Date().toISOString();
      await actor.update({
        'flags.omnipresence.id': id,
        'flags.omnipresence.ownerName': ownerName,
        'flags.omnipresence.syncedAt': now,
        'flags.omnipresence.localModifiedAt': now
      }, { omnipresenceInternal: true });
    }
    const registry = this._getAll();
    registry[id] = true;
    await game.settings.set('omnipresence', this.SETTING, registry);
    return id;
  }

  static async unenroll(actor) {
    const id = actor.getFlag('omnipresence', 'id');
    if (!id) return;
    const registry = this._getAll();
    delete registry[id];
    await game.settings.set('omnipresence', this.SETTING, registry);
  }
}
