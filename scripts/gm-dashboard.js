import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { JournalSync } from './journal-sync.js';
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
      forceSyncAll: this._onForceSyncAll,
      forcePushJournal: this._onForcePushJournal,
      forcePullJournal: this._onForcePullJournal,
      removeSyncJournal: this._onRemoveSyncJournal
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
    // When opened from the login flow this holds the ids of conflicting journals;
    // null when opened normally from settings (full dashboard).
    this.conflictJournalIds = options.conflictJournalIds ?? null;
  }

  get title() {
    if (this.conflictActorIds || this.conflictJournalIds) {
      return game.i18n.localize('OMNIPRESENCE.dashboard.conflictsTitle');
    }
    return game.i18n.localize(this.options.window.title);
  }

  /** Build display rows for a set of enrolled documents against their pack. */
  async _rowsFor(docs, packId) {
    let compById = null;
    try {
      const pack = game.packs.get(packId);
      if (pack) {
        const cdocs = await pack.getDocuments();
        compById = new Map(
          cdocs.map(d => [d.getFlag('omnipresence', 'id'), d.getFlag('omnipresence', 'syncedAt') ?? null])
        );
      }
    } catch (err) {
      console.warn('Omnipresence | dashboard pack load failed, using local-only badge', err);
      compById = null;
    }
    const compAvailable = compById !== null;
    const never = game.i18n.localize('OMNIPRESENCE.dashboard.never');
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : never);

    return docs.map(d => {
      const syncedAt = d.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = d.getFlag('omnipresence', 'localModifiedAt') ?? syncedAt;
      const opId = d.getFlag('omnipresence', 'id');
      const compSyncedAt = compById ? (compById.get(opId) ?? null) : null;
      const hasConflict = deriveConflictState({
        localSyncedAt: syncedAt,
        compSyncedAt,
        localModifiedAt,
        compAvailable
      });
      return {
        id: d.id,
        name: d.name,
        ownerName: d.getFlag('omnipresence', 'ownerName') ?? '—',
        syncedAtFormatted: fmt(syncedAt),
        localModifiedAtFormatted: fmt(localModifiedAt),
        compSyncedAtFormatted: fmt(compSyncedAt),
        hasConflict
      };
    });
  }

  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const conflictsOnly = !!(this.conflictActorIds || this.conflictJournalIds);

    // Actors.
    const allActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    let visibleActors = isGM ? allActors : allActors.filter(a => a.isOwner);
    if (conflictsOnly) {
      const ids = new Set(this.conflictActorIds ?? []);
      visibleActors = visibleActors.filter(a => ids.has(a.id));
    }
    let actors = await this._rowsFor(visibleActors, SyncEngine.PACK_ID);
    if (conflictsOnly) actors = actors.filter(r => r.hasConflict);

    // Journals.
    const allJournals = game.journal.filter(j => SyncRegistry.isEnrolled(j));
    let visibleJournals = isGM ? allJournals : allJournals.filter(j => j.isOwner);
    if (conflictsOnly) {
      const ids = new Set(this.conflictJournalIds ?? []);
      visibleJournals = visibleJournals.filter(j => ids.has(j.id));
    }
    let journals = await this._rowsFor(visibleJournals, JournalSync.PACK_ID);
    if (conflictsOnly) journals = journals.filter(r => r.hasConflict);

    return { isGM, actors, journals, conflictsOnly };
  }

  /**
   * In conflicts-only mode, close once all conflicts are resolved. Resolving a
   * row re-renders; resolved rows are filtered out of `context.actors`/`context.journals`,
   * so both tables being empty means done. onLogin only opens this view when at
   * least one conflict exists, so the initial render is never empty.
   */
  _onRender(context, options) {
    super._onRender(context, options);
    if (context.conflictsOnly && context.actors.length === 0 && context.journals.length === 0) {
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
    const enrolledJournals = game.journal.filter(j => SyncRegistry.isEnrolled(j));
    await Promise.all([
      ...enrolledActors.map(a => SyncEngine.push(a)),
      ...enrolledJournals.map(j => JournalSync.push(j))
    ]);
    this.render();
  }

  static async _onForcePushJournal(event, target) {
    const journalId = target.closest('[data-journal-id]').dataset.journalId;
    const journal = game.journal.get(journalId);
    if (!journal) return;
    if (!game.user.isGM && !journal.isOwner) return;
    await JournalSync.push(journal);
    this.render();
  }

  static async _onForcePullJournal(event, target) {
    const journalId = target.closest('[data-journal-id]').dataset.journalId;
    const journal = game.journal.get(journalId);
    if (!journal) return;
    if (!game.user.isGM && !journal.isOwner) return;
    const omnipresenceId = journal.getFlag('omnipresence', 'id');
    const pack = game.packs.get(JournalSync.PACK_ID);
    if (!pack) return;
    const docs = await pack.getDocuments();
    const compJournal = docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);
    if (!compJournal) return;
    await JournalSync.pull(journal, compJournal);
    this.render();
  }

  static async _onRemoveSyncJournal(event, target) {
    const journalId = target.closest('[data-journal-id]').dataset.journalId;
    const journal = game.journal.get(journalId);
    if (!journal) return;
    if (!game.user.isGM && !journal.isOwner) return;
    await SyncRegistry.unenroll(journal);
    ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: journal.name }));
    this.render();
  }
}
