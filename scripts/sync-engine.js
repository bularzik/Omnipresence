import { SyncRegistry } from './sync-registry.js';
import {
  decideSyncAction,
  stripWorldLocalFields,
  diffEmbedded,
  resolveOwningActor
} from './sync-logic.js';

const DEBOUNCE_MS = 2000;

export class SyncEngine {
  static _timers = new Map();   // actorId → timeout handle
  static _pending = new Map();  // actorId → actor (for flush on logout)

  /** Compendium id for the active world's game system. */
  static get PACK_ID() {
    return `omnipresence.omnipresence-${game.system.id}`;
  }

  static _getPack() {
    return game.packs.get(this.PACK_ID);
  }

  static async _getCompendiumActor(omnipresenceId) {
    const pack = this._getPack();
    if (!pack) return null;
    const docs = await pack.getDocuments();
    return docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId) ?? null;
  }

  static async push(actor) {
    // Only GM-role clients can write to a module compendium.
    if (!game.user.isGM) return;

    const pack = this._getPack();
    if (!pack) {
      console.warn('Omnipresence | compendium pack not found:', this.PACK_ID);
      return;
    }

    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    if (!omnipresenceId) return;

    const syncedAt = new Date().toISOString();

    // Strip world-local fields (_id, ownership, folder) before writing to the shared compendium.
    const actorData = stripWorldLocalFields(actor.toObject());

    // Strip world-local sync metadata and stamp the shared syncedAt.
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    delete actorData.flags.omnipresence.localModifiedAt;
    actorData.flags.omnipresence.syncedAt = syncedAt;

    try {
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        await existing.update(actorData);
      } else {
        await Actor.create(actorData, { pack: this.PACK_ID });
      }

      // Update local syncedAt to match (do not touch localModifiedAt).
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
    for (const [, timer] of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
    await Promise.all(pending.map(actor => this.push(actor)));
  }

  /**
   * Apply create/update/delete to one embedded collection so it matches
   * `snapshotDocs`. All writes carry omnipresenceInternal so the embedded
   * hooks ignore them. Creates use keepId so embedded _ids stay stable across
   * worlds (the cross-world match key).
   */
  static async _reconcileCollection(parent, embeddedName, snapshotDocs) {
    const collection = parent.getEmbeddedCollection(embeddedName);
    const localDocs = collection.map(d => d.toObject());
    const { toCreate, toUpdate, toDelete } = diffEmbedded(localDocs, snapshotDocs ?? []);

    if (toDelete.length) {
      await parent.deleteEmbeddedDocuments(embeddedName, toDelete, { omnipresenceInternal: true });
    }
    if (toCreate.length) {
      await parent.createEmbeddedDocuments(embeddedName, toCreate, {
        keepId: true,
        omnipresenceInternal: true
      });
    }
    if (toUpdate.length) {
      await parent.updateEmbeddedDocuments(embeddedName, toUpdate, { omnipresenceInternal: true });
    }
  }

  /**
   * Make targetActor's embedded data (items, their nested effects, and
   * actor-level effects) match snapshotData. snapshotData is plain actor data
   * (e.g. from toObject()) whose embedded _ids are preserved.
   */
  static async reconcileActorEmbedded(targetActor, snapshotData) {
    // 1. Items (inventory, spells, features).
    await this._reconcileCollection(targetActor, 'Item', snapshotData.items ?? []);

    // 2. Effects nested on items. Re-read items after the Item reconcile so newly
    //    created items are included (their effects self-heal if keepId did not
    //    carry to nested docs).
    const snapItemsById = new Map((snapshotData.items ?? []).map(i => [i._id, i]));
    for (const item of targetActor.items) {
      const snapItem = snapItemsById.get(item.id);
      if (!snapItem) continue;
      await this._reconcileCollection(item, 'ActiveEffect', snapItem.effects ?? []);
    }

    // 3. Actor-level effects (buffs, conditions).
    await this._reconcileCollection(targetActor, 'ActiveEffect', snapshotData.effects ?? []);
  }

  static async pull(localActor, compActor) {
    // Strip world-local fields so local ownership and folder are preserved.
    const actorData = stripWorldLocalFields(compActor.toObject());
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding).
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    await localActor.update(actorData, { omnipresenceInternal: true });
  }

  static async onLogin() {
    const pack = this._getPack();
    if (!pack) {
      if (game.user.isGM) {
        ui.notifications.info(
          game.i18n.format('OMNIPRESENCE.notifications.unsupportedSystem', { system: game.system.id })
        );
      }
      return;
    }

    const compActors = await pack.getDocuments();
    const myActors = game.actors.filter(a => a.isOwner && SyncRegistry.isEnrolled(a));

    // 1. Sync each of the current user's enrolled actors.
    for (const actor of myActors) {
      const omnipresenceId = actor.getFlag('omnipresence', 'id');
      const compActor = compActors.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);

      if (!compActor) {
        // No compendium entry — push local copy as master (GM only; no-op for players).
        await this.push(actor);
        continue;
      }

      const action = decideSyncAction({
        localSyncedAt: actor.getFlag('omnipresence', 'syncedAt'),
        compSyncedAt: compActor.getFlag('omnipresence', 'syncedAt'),
        localModifiedAt: actor.getFlag('omnipresence', 'localModifiedAt')
      });

      if (action === 'conflict') {
        const { ConflictResolver } = await import('./conflict-resolver.js');
        await ConflictResolver.resolve(actor, compActor, {
          onKeepLocal: () => this.push(actor),
          onUseShared: () => this.pull(actor, compActor)
        });
      } else if (action === 'pull') {
        await this.pull(actor, compActor);
      } else if (action === 'push') {
        await this.push(actor);
      }
      // 'none': in sync
    }

    // 2. Auto-import: compendium actors not present in this world (GM only).
    if (!game.user.isGM) return;
    const localOmnipresenceIds = new Set(
      game.actors
        .filter(a => SyncRegistry.isEnrolled(a))
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

      const actorData = stripWorldLocalFields(compActor.toObject());
      actorData.flags ??= {};
      actorData.flags.omnipresence ??= {};
      actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
      actorData.ownership = { default: 0, [matchingUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

      const created = await Actor.create(actorData);
      await SyncRegistry.enroll(created);
    }
  }
}
