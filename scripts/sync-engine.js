import { SyncRegistry } from './sync-registry.js';

const PACK_ID = 'omnipresence.omnipresence-actors';
const DEBOUNCE_MS = 2000;

export class SyncEngine {
  static _timers = new Map();   // actorId → timeout handle
  static _pending = new Map();  // actorId → actor (for flush on logout)

  static _getPack() {
    return game.packs.get(PACK_ID);
  }

  static async _getCompendiumActor(omnipresenceId) {
    const pack = this._getPack();
    if (!pack) return null;
    const docs = await pack.getDocuments();
    return docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId) ?? null;
  }

  static async push(actor) {
    const pack = this._getPack();
    if (!pack) {
      console.warn('Omnipresence | compendium pack not found:', PACK_ID);
      return;
    }

    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    if (!omnipresenceId) return;

    const syncedAt = new Date().toISOString();
    const actorData = actor.toObject();

    // Strip world-local metadata before writing to compendium
    delete actorData.flags?.omnipresence?.localModifiedAt;
    actorData.flags.omnipresence.syncedAt = syncedAt;

    try {
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        // Preserve the compendium document's own _id
        const { _id, ...rest } = actorData;
        await existing.update(rest);
      } else {
        delete actorData._id;
        await Actor.create(actorData, { pack: PACK_ID });
      }

      // Update local syncedAt to match (do not touch localModifiedAt)
      await actor.update(
        { 'flags.omnipresence.syncedAt': syncedAt },
        { omnipresenceInternal: true }
      );

      this._pending.delete(actor.id);
    } catch (err) {
      console.error('Omnipresence | push failed for', actor.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: actor.name })
      );
    }
  }

  static debouncedPush(actor) {
    const id = actor.id;
    if (this._timers.has(id)) clearTimeout(this._timers.get(id));
    this._pending.set(id, actor);
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this.push(actor);
    }, DEBOUNCE_MS);
    this._timers.set(id, timer);
  }

  static async trackLocalModification(actor) {
    await actor.update(
      { 'flags.omnipresence.localModifiedAt': new Date().toISOString() },
      { omnipresenceInternal: true }
    );
  }

  static async flushPending() {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const [id, timer] of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
    await Promise.all(pending.map(actor => this.push(actor)));
  }

  // Implemented in Task 5
  static async onLogin() {}
}
