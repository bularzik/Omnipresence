import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { deriveConflictState } from './sync-logic.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class OmnipresenceDashboard extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'omnipresence-dashboard',
    classes: ['omnipresence'],
    window: {
      title: 'OMNIPRESENCE.dashboard.title',
      resizable: true
    },
    position: {
      width: 620,
      height: 'auto'
    },
    // ApplicationV2 expects each action to map to a handler function. Reference
    // the static handlers (called with the instance as `this`); `true` here was
    // a no-op that made #onClickAction throw "handler?.call is not a function".
    actions: {
      forcePush: this._onForcePush,
      forcePull: this._onForcePull,
      removeSync: this._onRemoveSync,
      forceSyncAll: this._onForceSyncAll
    }
  };

  static PARTS = {
    main: {
      template: 'modules/omnipresence/templates/settings-panel.hbs'
    }
  };

  constructor(options = {}) {
    super(options);
    // When opened from the login flow this holds the ids of conflicting actors;
    // null when opened normally from settings (full dashboard).
    this.conflictActorIds = options.conflictActorIds ?? null;
  }

  get title() {
    if (this.conflictActorIds) {
      return game.i18n.localize('OMNIPRESENCE.dashboard.conflictsTitle');
    }
    return game.i18n.localize(this.options.window.title);
  }

  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const allActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    let visibleActors = isGM ? allActors : allActors.filter(a => a.isOwner);
    if (this.conflictActorIds) {
      const ids = new Set(this.conflictActorIds);
      visibleActors = visibleActors.filter(a => ids.has(a.id));
    }

    // Load shared syncedAt per actor so the conflict badge is authoritative.
    // compById maps omnipresence-id → shared syncedAt; null if the pack is
    // unavailable, in which case deriveConflictState falls back to local-only.
    let compById = null;
    try {
      const pack = game.packs.get(SyncEngine.PACK_ID);
      if (pack) {
        const docs = await pack.getDocuments();
        compById = new Map(
          docs.map(d => [d.getFlag('omnipresence', 'id'), d.getFlag('omnipresence', 'syncedAt') ?? null])
        );
      }
    } catch (err) {
      console.warn('Omnipresence | dashboard pack load failed, using local-only badge', err);
      compById = null;
    }
    const compAvailable = compById !== null;

    const never = game.i18n.localize('OMNIPRESENCE.dashboard.never');
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : never);

    let actors = visibleActors.map(a => {
      const syncedAt = a.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = a.getFlag('omnipresence', 'localModifiedAt') ?? syncedAt;
      const opId = a.getFlag('omnipresence', 'id');
      const compSyncedAt = compById ? (compById.get(opId) ?? null) : null;
      const hasConflict = deriveConflictState({
        localSyncedAt: syncedAt,
        compSyncedAt,
        localModifiedAt,
        compAvailable
      });
      return {
        id: a.id,
        name: a.name,
        ownerName: a.getFlag('omnipresence', 'ownerName') ?? '—',
        syncedAtFormatted: syncedAt ? new Date(syncedAt).toLocaleString() : never,
        localModifiedAtFormatted: fmt(localModifiedAt),
        compSyncedAtFormatted: fmt(compSyncedAt),
        hasConflict
      };
    });

    // In conflicts-only mode, drop rows that are no longer in conflict so that
    // resolving the last one empties the table (a later task auto-closes the window).
    if (this.conflictActorIds) {
      actors = actors.filter(r => r.hasConflict);
    }

    return { isGM, actors, conflictsOnly: !!this.conflictActorIds };
  }

  /**
   * In conflicts-only mode, close once all conflicts are resolved. Resolving a
   * row re-renders; resolved rows are filtered out of `context.actors`, so an
   * empty table means done. onLogin only opens this view when at least one
   * conflict exists, so the initial render is never empty.
   */
  _onRender(context, options) {
    super._onRender(context, options);
    if (this.conflictActorIds && context.actors.length === 0) {
      this.close();
    }
  }

  static async _onForcePush(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    if (!game.user.isGM && !actor.isOwner) return;
    await SyncEngine.push(actor);
    this.render();
  }

  static async _onForcePull(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    if (!game.user.isGM && !actor.isOwner) return;
    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    const pack = game.packs.get(SyncEngine.PACK_ID);
    if (!pack) return;
    const docs = await pack.getDocuments();
    const compActor = docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);
    if (!compActor) return;
    await SyncEngine.pull(actor, compActor);
    this.render();
  }

  static async _onRemoveSync(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    if (!game.user.isGM && !actor.isOwner) return;
    await SyncRegistry.unenroll(actor);
    ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
    this.render();
  }

  static async _onForceSyncAll(event, target) {
    if (!game.user.isGM) return;
    const enrolledActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    await Promise.all(enrolledActors.map(a => SyncEngine.push(a)));
    this.render();
  }
}
