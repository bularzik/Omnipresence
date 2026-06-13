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
      forcePush: OmnipresenceDashboard._onForcePush,
      forcePull: OmnipresenceDashboard._onForcePull,
      removeSync: OmnipresenceDashboard._onRemoveSync,
      forceSyncAll: OmnipresenceDashboard._onForceSyncAll
    }
  };

  static PARTS = {
    main: {
      template: 'modules/omnipresence/templates/settings-panel.hbs'
    }
  };

  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const allActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    const visibleActors = isGM ? allActors : allActors.filter(a => a.isOwner);

    const actors = visibleActors.map(a => {
      const syncedAt = a.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = a.getFlag('omnipresence', 'localModifiedAt') ?? syncedAt;
      const hasConflict = localModifiedAt > syncedAt;
      return {
        id: a.id,
        name: a.name,
        ownerName: a.getFlag('omnipresence', 'ownerName') ?? '—',
        syncedAtFormatted: syncedAt ? new Date(syncedAt).toLocaleString() : game.i18n.localize('OMNIPRESENCE.dashboard.never'),
        hasConflict
      };
    });

    return { isGM, actors };
  }

  static async _onForcePush(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    await SyncEngine.push(actor);
    this.render();
  }

  static async _onForcePull(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    const pack = game.packs.get('omnipresence.omnipresence-actors');
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
    await SyncRegistry.unenroll(actor);
    ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
    this.render();
  }

  static async _onForceSyncAll(event, target) {
    const enrolledActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    await Promise.all(enrolledActors.map(a => SyncEngine.push(a)));
    this.render();
  }
}
