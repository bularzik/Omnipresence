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

  static async pull(localActor, compActor) {
    const actorData = compActor.toObject();
    delete actorData._id;
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding)
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    await localActor.update(actorData, { omnipresenceInternal: true });
  }

  static async onLogin() {
    const pack = this._getPack();
    if (!pack) return;

    const compActors = await pack.getDocuments();
    const myActors = game.actors.filter(a => a.isOwner && SyncRegistry.isEnrolled(a));

    // 1. Sync each of the current user's enrolled actors
    for (const actor of myActors) {
      const omnipresenceId = actor.getFlag('omnipresence', 'id');
      const compActor = compActors.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);

      if (!compActor) {
        // No compendium entry — push local copy as master
        await this.push(actor);
        continue;
      }

      const localSyncedAt = actor.getFlag('omnipresence', 'syncedAt');
      const compSyncedAt = compActor.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = actor.getFlag('omnipresence', 'localModifiedAt') ?? localSyncedAt;

      const localSyncTime = localSyncedAt ? new Date(localSyncedAt).getTime() : 0;
      const compSyncTime = compSyncedAt ? new Date(compSyncedAt).getTime() : 0;
      const localModTime = localModifiedAt ? new Date(localModifiedAt).getTime() : 0;

      const compNewer = compSyncTime > localSyncTime;
      const localChanged = localModTime > localSyncTime;

      if (compNewer && localChanged) {
        // Both sides have changes — prompt user
        const { ConflictResolver } = await import('./conflict-resolver.js');
        await ConflictResolver.resolve(actor, compActor, {
          onKeepLocal: () => this.push(actor),
          onUseShared: () => this.pull(actor, compActor)
        });
      } else if (compNewer) {
        await this.pull(actor, compActor);
      } else if (localSyncTime > compSyncTime) {
        await this.push(actor);
      }
      // else: in sync
    }

    // 2. Auto-import: compendium actors not present in this world
    const localOmnipresenceIds = new Set(
      game.actors
        .filter(a => a.getFlag('omnipresence', 'id'))
        .map(a => a.getFlag('omnipresence', 'id'))
    );

    for (const compActor of compActors) {
      const omnipresenceId = compActor.getFlag('omnipresence', 'id');
      if (!omnipresenceId) continue;
      if (localOmnipresenceIds.has(omnipresenceId)) continue;

      const ownerName = compActor.getFlag('omnipresence', 'ownerName');
      if (!ownerName) {
        console.warn('Omnipresence | compendium actor has no ownerName, skipping auto-import:', compActor.name);
        continue;
      }

      const matchingUser = game.users.find(u => u.name === ownerName);
      if (!matchingUser) {
        console.warn('Omnipresence | no user named', ownerName, '— skipping auto-import of', compActor.name);
        continue;
      }

      const actorData = compActor.toObject();
      delete actorData._id;
      actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
      actorData.ownership = { default: 0, [matchingUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

      const created = await Actor.create(actorData);
      await SyncRegistry.enroll(created);
    }
  }
}
