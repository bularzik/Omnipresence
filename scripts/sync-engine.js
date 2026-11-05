import { LinkRewriter } from './link-rewriter.js';
import { SyncRegistry } from './sync-registry.js';
import { Bindings } from './bindings.js';
import {
  decideSyncAction,
  stripWorldLocalFields,
  resolveOwningActor,
  shouldImportFor,
  findUnsyncedLookalike,
  mergeForeignFlags,
  resolveMerge,
  withLocalStats
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
      // A merged-away stub is a redirect: pushing over it would resurrect the
      // duplicate. The owner's next login follows it instead (_followMerge).
      if (existing?.getFlag('omnipresence', 'mergedInto')) return;
      // Only the document bound to this omni id may write its shared copy
      // (#1): a player can stamp any id on an actor they own.
      if (!(await Bindings.authorizePush(actor, !!existing))) return;
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
      this.push(actor).catch(err => console.error('Omnipresence | push failed for', actor.name, err));
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

  /**
   * Mark an actor dirty. Every caller is a hook that does not await it, so
   * log failures here instead of leaving an unhandled rejection.
   */
  static async trackLocalModification(actor) {
    try {
      await actor.update(
        { 'flags.omnipresence.localModifiedAt': new Date().toISOString() },
        { omnipresenceInternal: true }
      );
    } catch (err) {
      console.error('Omnipresence | dirty-mark failed for', actor.name, err);
    }
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
    if (SyncRegistry.isPusher()) this.debouncedPush(actor);
  }

  /**
   * Overwrite `localActor` from its shared copy. Every pull path (login,
   * dashboard force-pull) goes through here, so the pull rule lives here:
   * once bindings are built only the bound document is written (I-1).
   * @param {Actor} localActor
   * @param {Actor} compActor
   * @param {object} [opts]
   * @param {boolean} [opts.keepForeignFlags] keep the local actor's other
   *   modules' flags (e.g. ddbimporter) — used by linking and merge re-keys
   * @param {boolean} [opts.authorized] the caller already checked this user
   *   may take this shared copy (linkActor: a GM, or the copy's own player),
   *   so the binding check is skipped for this one re-key
   * @returns {Promise<boolean>} whether the local actor now holds the shared data
   */
  static async pull(localActor, compActor, { keepForeignFlags = false, authorized = false } = {}) {
    // A merged-away stub holds no data: pulling it would empty the actor.
    if (compActor.getFlag('omnipresence', 'mergedInto')) return false;
    if (!authorized && !(await Bindings.mayPull(localActor))) return false;
    // Strip world-local fields so local ownership and folder are preserved,
    // and localize canonical omnipresence ids to this world's ids.
    const actorData = LinkRewriter.localize(stripWorldLocalFields(compActor.toObject()));
    if (keepForeignFlags) actorData.flags = mergeForeignFlags(localActor.toObject().flags, actorData.flags);
    actorData.flags ??= {};
    actorData.flags.omnipresence ??= {};
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding).
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    // Enrollment is this world's choice, not the shared copy's: keep it.
    const enrolled = localActor.getFlag('omnipresence', 'enrolled');
    if (enrolled !== undefined) actorData.flags.omnipresence.enrolled = enrolled;
    try {
      // Keep this world's _stats: a non-recursive update would replace it.
      await localActor.update(withLocalStats(actorData, localActor.toObject()), { omnipresenceInternal: true, recursive: false });
    } catch (err) {
      console.error('Omnipresence | pull failed for', localActor.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: localActor.name })
      );
      return false;
    }
    return true;
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

      // A local actor whose id is bound to a different document must never be
      // overwritten from (or pushed over) that document's shared copy (#1).
      const bound = Bindings.get(omnipresenceId);
      if (bound && !Bindings.isBoundTo(actor)) {
        console.warn(`Omnipresence | skipping login sync of "${actor.name}" (${actor.id}): its sync id is bound to another document.`);
        continue;
      }
      // Once bindings exist, an unbound carrier of an id whose shared copy
      // exists never syncs: the copy may have been made by a forgery in
      // another world's first-push race.
      if (compActor && !(await Bindings.mayPull(actor))) continue;

      // Gate on the OWNER's preference and allow-list (the user named by
      // ownerName, or this GM for a GM-owned actor) — never on the acting
      // GM's list, which would let a GM's picker silently stop a player's
      // actor from syncing.
      const gateUser = SyncRegistry.gateUser(actor.getFlag('omnipresence', 'ownerName') ?? null);
      if (!gateUser) continue;
      if (!SyncRegistry.isActorSyncEnabled(gateUser.id)) continue;
      if (!SyncRegistry.isDocSelected(gateUser.id, 'actor', omnipresenceId)) continue;

      // A merged-away shared copy is a redirect, never data: follow it and
      // never pull (it is empty) or push (that would resurrect the duplicate).
      if (compActor?.getFlag('omnipresence', 'mergedInto')) {
        if (await this._followMerge(actor, compActors, gateUser) === 'conflict') conflicts.push(actor.id);
        continue;
      }

      if (!compActor) {
        // No compendium entry — push local copy as master (the active GM only, #7).
        if (SyncRegistry.isPusher()) await this.push(actor);
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
        if (SyncRegistry.isPusher()) await this.push(actor);
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
  // Characters already warned about as unsynced lookalikes this session.
  // Every live import re-runs the check, so without this the same warning
  // repeats on each selection change.
  static _warnedLookalike = new Set();

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
            // Explicit ownership only: an NPC every player owns through
            // "default" is not this player's character.
            ownedByGateUser: a.ownership?.[gateUser.id] === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
          }))
        );
        if (lookalike) {
          // Tell the owner on their own client; the GM only when the owner
          // is offline (otherwise both would see it for one actor).
          if ((isSelf || (game.user.isGM && !gateUser.active)) && !this._warnedLookalike.has(omnipresenceId)) {
            this._warnedLookalike.add(omnipresenceId);
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
        // ...and the selection: a merge may have retired this id meanwhile.
        if (!SyncRegistry.isDocSelected(gateUser.id, 'actor', omnipresenceId)) continue;
        this._importing.add(omnipresenceId);
        try {
          // Internal: the createActor hook must not clear the id this import sets.
          const actor = await Actor.create(actorData, { keepId: true, omnipresenceInternal: true });
          await SyncRegistry.enroll(actor);
          // A GM import comes from the pack: bind it. A player's import is
          // bound by the active GM (Bindings.adopt, from the create hook).
          if (game.user.isGM) await Bindings.bind(actor);
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

  /**
   * This world still holds a copy of a duplicate (Y) that was merged into
   * another shared character (X) elsewhere.
   * - No local X, Y clean: re-key this actor to X and take X's data (keeping
   *   other modules' flags).
   * - No local X, Y has unpushed edits: re-key to X but KEEP the edits, with
   *   timestamps that make it a conflict for the user to resolve.
   * - A local X that is out of sync is detached (kept, id cleared) and
   *   treated as absent: this actor becomes X as above.
   * - A synced local X exists: this actor is a duplicate. Delete it when
   *   clean (and permitted), else take it out of sync and tell the owner.
   * The owner's selection swaps Y for X LAST, and X is held as "import in
   * flight" throughout: a selection write starts a live import, which must
   * not create X before this actor carries it (the linkActor race).
   * @returns {Promise<'conflict'|undefined>}
   */
  static async _followMerge(actor, compActors, gateUser) {
    const fromId = actor.getFlag('omnipresence', 'id');
    const mergedIntoById = {};
    for (const d of compActors) {
      const to = d.getFlag('omnipresence', 'mergedInto');
      if (to) mergedIntoById[d.getFlag('omnipresence', 'id')] = to;
    }
    const target = resolveMerge(fromId, mergedIntoById);
    const targetComp = target && compActors.find(d => d.getFlag('omnipresence', 'id') === target);
    if (!targetComp) {
      console.warn('Omnipresence | cannot follow merge of', actor.name, '(cycle or missing target)', fromId);
      return;
    }
    const dirty = Date.parse(actor.getFlag('omnipresence', 'localModifiedAt') ?? 0) >
                  Date.parse(actor.getFlag('omnipresence', 'syncedAt') ?? 0);
    let result;
    this._importing.add(target);
    try {
      const others = game.actors.filter(a => a.id !== actor.id && a.getFlag('omnipresence', 'id') === target);
      // Only a SYNCED local X counts. A copy deliberately taken out of sync is
      // not the world's copy of this character: detach it fully (kept as an
      // ordinary actor) so this actor can become X without a second id holder.
      for (const outOfSync of others.filter(a => !SyncRegistry.isEnrolled(a))) {
        await outOfSync.update(
          { 'flags.omnipresence.id': null, 'flags.omnipresence.enrolled': false },
          { omnipresenceInternal: true }
        );
        ui.notifications.warn(game.i18n.format('OMNIPRESENCE.notifications.mergeOutOfSyncDetached', { name: outOfSync.name }));
      }
      const localTarget = others.find(a => SyncRegistry.isEnrolled(a));
      if (!localTarget) {
        if (dirty) {
          // An epoch syncedAt with the newer localModifiedAt kept reads as
          // `conflict` against X: nothing edited here is silently lost.
          await actor.update(
            { 'flags.omnipresence.id': target, 'flags.omnipresence.syncedAt': new Date(0).toISOString() },
            { omnipresenceInternal: true }
          );
          result = 'conflict';
        } else {
          await actor.update({ 'flags.omnipresence.id': target }, { omnipresenceInternal: true });
          // The redirect is GM-written and this actor is the gate user's
          // copy of `fromId`, so it may take X before it is bound to it.
          await this.pull(actor, targetComp, { keepForeignFlags: true, authorized: true });
        }
        await SyncRegistry.enroll(actor);
        // A GM binds it now; a player's is bound by the active GM (Bindings.adopt).
        if (game.user.isGM) await Bindings.bind(actor);
      } else if (!dirty && actor.canUserModify(game.user, 'delete')) {
        await actor.delete({ omnipresenceInternal: true });
      } else {
        await actor.update(
          { 'flags.omnipresence.id': null, 'flags.omnipresence.enrolled': false },
          { omnipresenceInternal: true }
        );
        ui.notifications.warn(game.i18n.format(
          dirty ? 'OMNIPRESENCE.notifications.mergeDuplicateKept' : 'OMNIPRESENCE.notifications.mergeDuplicateDetached',
          { name: actor.name }
        ));
      }
      if (gateUser.id === game.user.id || game.user.isGM) {
        await SyncRegistry.removeFromSelection(gateUser.id, 'actor', fromId);
        await SyncRegistry.addToSelection(gateUser.id, 'actor', target);
      }
    } catch (err) {
      console.error('Omnipresence | following merge failed for', actor.name, err);
    } finally {
      this._importing.delete(target);
    }
    return result;
  }
}
