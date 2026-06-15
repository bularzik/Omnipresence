import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';

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
    actions: {
      forcePush: true,
      forcePull: true,
      removeSync: true,
      forceSyncAll: true
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

    const actors = visibleActors.map(a => {
      const syncedAt = a.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = a.getFlag('omnipresence', 'localModifiedAt') ?? syncedAt;
      const hasConflict = !!syncedAt && !!localModifiedAt && localModifiedAt > syncedAt;
      return {
        id: a.id,
        name: a.name,
        ownerName: a.getFlag('omnipresence', 'ownerName') ?? '—',
        syncedAtFormatted: syncedAt ? new Date(syncedAt).toLocaleString() : game.i18n.localize('OMNIPRESENCE.dashboard.never'),
        hasConflict
      };
    });

    return { isGM, actors, conflictsOnly: !!this.conflictActorIds };
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
