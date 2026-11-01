import { LinkRewriter } from './link-rewriter.js';
import { SyncRegistry } from './sync-registry.js';
import {
  decideSyncAction,
  stripWorldLocalFields,
  resolveOwningActor,
  shouldImportFor,
  findUnsyncedLookalike
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
        // recursive:false — the payload is a complete snapshot, so replace
        // subtrees wholesale; merge would resurrect deleted keys forever.
        // This one update also synchronizes the embedded collections (items,
        // actor-level effects, and effects nested on items) in full, including
        // deletions — measured against Foundry v13, see the op-yup spec. No
        // separate reconcile pass is needed.
        await existing.update(actorData, { omnipresenceInternal: true, recursive: false });
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

  /**
   * Cancel (never flush) all pending debounced pushes. Called on page unload
   * so no write can fire into the world-teardown window; the edits that
   * scheduled them are already dirty-marked and push at the next login.
   */
  static cancelPending() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
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

  static async pull(localActor, compActor) {
    // Strip world-local fields so local ownership and folder are preserved,
    // and localize canonical omnipresence ids to this world's ids.
    const actorData = LinkRewriter.localize(stripWorldLocalFields(compActor.toObject()));
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding).
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    try {
      await localActor.update(actorData, { omnipresenceInternal: true, recursive: false });
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

      // Gate on the OWNER's preference and allow-list (the user named by
      // ownerName, or this GM for a GM-owned actor) — never on the acting
      // GM's list, which would let a GM's picker silently stop a player's
      // actor from syncing.
      const gateUser = SyncRegistry.gateUser(actor.getFlag('omnipresence', 'ownerName') ?? null);
      if (!gateUser) continue;
      if (!SyncRegistry.isActorSyncEnabled(gateUser.id)) continue;
      if (!SyncRegistry.isDocSelected(gateUser.id, 'actor', omnipresenceId)) continue;

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

    // 2. Auto-import: compendium actors not present in this world. Who
    // imports a given pick is decided per gate user (shouldImportFor): the
    // player themselves with "Create New Actors", otherwise a GM.
    await this.importMissing({ compActors });

    return conflicts;
  }

  // Omnipresence ids with an import in flight on this client. Two overlapping
  // runs (ready-hook reconcile + an updateUser-triggered import) would
  // otherwise both create the same actor.
  static _importing = new Set();

  /**
   * Import compendium actors that are selected by their gate user but absent
   * from this world, when THIS client is the one that should import them.
   * Skips merged-away stubs and never creates a second copy of a PC that
   * already exists here unsynced (duplicate guard: notifies instead).
   * @param {object} [opts]
   * @param {string|null} [opts.forUserId] only that gate user's picks
   * @param {Actor[]} [opts.compActors] pack documents already loaded
   * @returns {Promise<Actor[]>} the actors created
   */
  static async importMissing({ forUserId = null, compActors = null } = {}) {
    const pack = this._getPack();
    if (!pack) return [];
    compActors ??= await pack.getDocuments();
    const created = [];

    for (const compActor of compActors) {
      const omnipresenceId = compActor.getFlag('omnipresence', 'id');
      if (!omnipresenceId) continue;
      if (compActor.getFlag('omnipresence', 'mergedInto')) continue;
      if (this._hasLocal(omnipresenceId) || this._importing.has(omnipresenceId)) continue;

      // One malformed pack copy must not abort the remaining imports — or,
      // via ready's serial awaits, macro/journal sync and login healing.
      try {
        // The gate user: the named owner, or this GM for a GM-owned copy (no
        // ownerName). GM-owned documents import GM-only and are opted into
        // through the GM's own allow-list, which is also what makes the
        // documented delete-then-re-import contract hold for them (op-74f).
        const ownerName = compActor.getFlag('omnipresence', 'ownerName') ?? null;
        const gateUser = SyncRegistry.gateUser(ownerName);
        if (!gateUser) {
          if (game.user.isGM) console.warn('Omnipresence | no user named', ownerName, '— skipping auto-import of', compActor.name);
          continue;
        }
        if (forUserId && gateUser.id !== forUserId) continue;

        // Import only what the owning user enabled and opted into for this world.
        if (!SyncRegistry.isActorSyncEnabled(gateUser.id)) continue;
        if (!SyncRegistry.isDocSelected(gateUser.id, 'actor', omnipresenceId)) continue;

        const isSelf = gateUser.id === game.user.id;
        const lookalike = findUnsyncedLookalike(
          { name: compActor.name, ownerName },
          game.actors.map(a => ({
            id: a.id,
            name: a.name,
            enrolled: SyncRegistry.isEnrolled(a),
            ownedByGateUser: a.testUserPermission(gateUser, 'OWNER')
          }))
        );
        if (lookalike) {
          // Tell the owner on their own client; the GM only when the owner
          // is offline (otherwise both would see it for one actor).
          if (isSelf || (game.user.isGM && !gateUser.active)) {
            ui.notifications.warn(game.i18n.format('OMNIPRESENCE.notifications.unsyncedLookalike', { name: compActor.name }));
          }
          continue;
        }

        if (!shouldImportFor({
          isGM: game.user.isGM,
          isSelf,
          ownerIsGM: !ownerName,
          ownerActive: !!gateUser.active,
          ownerCanCreate: !!gateUser.can?.('ACTOR_CREATE')
        })) continue;

        const actorData = LinkRewriter.localize(stripWorldLocalFields(compActor.toObject()));
        actorData.flags ??= {};
        actorData.flags.omnipresence ??= {};
        actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
        actorData.ownership = ownerName
          ? { default: 0, [gateUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }
          : { default: 0 };

        // Re-check synchronously right before the write: an overlapping run
        // may have finished this id since the loop started.
        if (this._hasLocal(omnipresenceId) || this._importing.has(omnipresenceId)) continue;
        this._importing.add(omnipresenceId);
        try {
          const actor = await Actor.create(actorData, { keepId: true });
          await SyncRegistry.enroll(actor);
          created.push(actor);
        } finally {
          this._importing.delete(omnipresenceId);
        }
      } catch (err) {
        console.error('Omnipresence | actor auto-import failed for', compActor.name, err);
      }
    }
    return created;
  }

  static _hasLocal(omnipresenceId) {
    return game.actors.some(a => SyncRegistry.isEnrolled(a) && a.getFlag('omnipresence', 'id') === omnipresenceId);
  }
}
