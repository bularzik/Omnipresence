import { LinkRewriter } from './link-rewriter.js';
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

    // Strip world-local fields (_id, ownership, folder) and canonicalize links
    // so the pack copy is world-independent.
    const actorData = LinkRewriter.canonicalize(stripWorldLocalFields(actor.toObject()));

    // Strip world-local sync metadata and stamp the shared syncedAt.
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    delete actorData.flags.omnipresence.localModifiedAt;
    actorData.flags.omnipresence.syncedAt = syncedAt;
    // Re-stamp ownerName from current ownership so the pack copy never goes
    // stale (e.g. ownership granted after enrollment); drives cross-world import.
    actorData.flags.omnipresence.ownerName = SyncRegistry.resolveOwnerName(actor);

    try {
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        await existing.update(actorData);
        await this.reconcileActorEmbedded(existing, actorData);
      } else {
        await Actor.create(actorData, { pack: this.PACK_ID, keepId: true });
      }

      // Update local syncedAt to match (do not touch localModifiedAt).
      await actor.update(
        { 'flags.omnipresence.syncedAt': syncedAt },
        { omnipresenceInternal: true }
      );

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

  /**
   * Route an embedded-document change to the owning enrolled actor: mark dirty
   * (editing user) and debounce a push (GM). Mirrors the updateActor handler.
   */
  static handleEmbeddedChange(doc, options, userId) {
    if (options?.omnipresenceInternal) return;
    // Compendium copies fire these hooks too (our own pushes) — never treat a
    // pack doc as a local enrolled doc, or the push feeds back on itself.
    if (doc.pack) return;
    const actor = resolveOwningActor(doc);
    if (!actor) return;
    if (!SyncRegistry.isEnrolled(actor)) return;
    if (userId === game.user.id) this.trackLocalModification(actor);
    if (game.user.isGM) this.debouncedPush(actor);
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
      const snapItem = snapItemsById.get(item._id);
      if (!snapItem) continue;
      await this._reconcileCollection(item, 'ActiveEffect', snapItem.effects ?? []);
    }

    // 3. Actor-level effects (buffs, conditions).
    await this._reconcileCollection(targetActor, 'ActiveEffect', snapshotData.effects ?? []);
  }

  static async pull(localActor, compActor) {
    // Strip world-local fields so local ownership and folder are preserved,
    // and localize canonical omnipresence ids to this world's ids.
    const actorData = LinkRewriter.localize(stripWorldLocalFields(compActor.toObject()));
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding).
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    try {
      await localActor.update(actorData, { omnipresenceInternal: true });
      await this.reconcileActorEmbedded(localActor, actorData);
    } catch (err) {
      console.error('Omnipresence | pull failed for', localActor.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: localActor.name })
      );
    }
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

    if (!SyncRegistry.isActorSyncEnabled(game.user.id)) return;

    const compActors = await pack.getDocuments();
    const myActors = game.actors.filter(a => a.isOwner && SyncRegistry.isEnrolled(a));

    // 1. Sync each of the current user's enrolled actors.
    const conflicts = [];
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
        conflicts.push(actor.id);
      } else if (action === 'pull') {
        await this.pull(actor, compActor);
      } else if (action === 'push') {
        await this.push(actor);
      }
      // 'none': in sync
    }

    // Conflicts are surfaced by the caller (ready hook) in one consolidated
    // dashboard shared with journal conflicts — return them instead of opening
    // a second window here.

    // 2. Auto-import: compendium actors not present in this world (GM only).
    if (!game.user.isGM) return conflicts;
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

      const actorData = LinkRewriter.localize(stripWorldLocalFields(compActor.toObject()));
      actorData.flags ??= {};
      actorData.flags.omnipresence ??= {};
      actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
      actorData.ownership = { default: 0, [matchingUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

      const created = await Actor.create(actorData, { keepId: true });
      await SyncRegistry.enroll(created);
    }

    return conflicts;
  }
}
