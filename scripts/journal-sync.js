import { LinkRewriter } from './link-rewriter.js';
import { SyncRegistry } from './sync-registry.js';
import {
  decideSyncAction,
  stripWorldLocalFields,
  diffEmbedded,
  resolveOwningJournal,
  requiredModulesForJournal,
  worldLocalMediaPaths,
  capturePinPayload,
  localizePins
} from './sync-logic.js';

const DEBOUNCE_MS = 2000;

export class JournalSync {
  static _timers = new Map(); // journalId → timeout handle

  static get PACK_ID() {
    return 'omnipresence.omnipresence-journals';
  }

  static _getPack() {
    return game.packs.get(this.PACK_ID);
  }

  static async _getCompendiumJournal(omnipresenceId) {
    const pack = this._getPack();
    if (!pack) return null;
    const docs = await pack.getDocuments();
    return docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId) ?? null;
  }

  /** Strip world-local per-page ownership so page ownership never crosses worlds. */
  static _stripPageOwnership(journalData) {
    for (const page of journalData.pages ?? []) delete page.ownership;
    return journalData;
  }

  /**
   * Gather this journal's map pins across all local scenes for the pack
   * payload. Duplicate scene names: first match wins, one warning per push.
   */
  static _capturePins(journal, omnipresenceId) {
    const sceneNotes = game.scenes.map(s => ({
      sceneName: s.name,
      notes: s.notes.map(n => n.toObject())
    }));
    const { pins, duplicateSceneNames } =
      capturePinPayload(sceneNotes, journal.id, omnipresenceId);
    if (duplicateSceneNames.length) {
      console.warn(
        'Omnipresence | duplicate scene names — pins captured from the first match only:',
        duplicateSceneNames.join(', ')
      );
    }
    return pins;
  }

  static async push(journal) {
    // Only GM-role clients can write to a module compendium.
    if (!game.user.isGM) return;

    const pack = this._getPack();
    if (!pack) {
      console.warn('Omnipresence | journals pack not found:', this.PACK_ID);
      return;
    }

    const omnipresenceId = journal.getFlag('omnipresence', 'id');
    if (!omnipresenceId) return;

    const syncedAt = new Date().toISOString();

    // Strip world-local fields (top-level _id/ownership/folder) and per-page
    // ownership, then attach the pin payload and canonicalize links so the
    // whole pack copy — pins included — is world-independent. (The pin
    // entryId is pre-canonicalized by capture; a bare omni id is untouched
    // by the walk. Always set, so [] mirrors deletions; pull/import strip it.)
    const rawData = this._stripPageOwnership(stripWorldLocalFields(journal.toObject()));
    rawData.flags ??= {};
    rawData.flags.omnipresence ??= {};
    rawData.flags.omnipresence.pins = this._capturePins(journal, omnipresenceId);
    const journalData = LinkRewriter.canonicalize(rawData);
    journalData.flags.omnipresence ??= {};
    delete journalData.flags.omnipresence.localModifiedAt;
    journalData.flags.omnipresence.syncedAt = syncedAt;
    // Re-stamp ownerName from current ownership so the pack copy never goes
    // stale (e.g. ownership granted after enrollment); drives cross-world import.
    journalData.flags.omnipresence.ownerName = SyncRegistry.resolveOwnerName(journal);

    try {
      const existing = await this._getCompendiumJournal(omnipresenceId);
      if (existing) {
        // recursive:false — the payload is a complete snapshot, so replace
        // subtrees wholesale; merge would resurrect deleted keys forever.
        await existing.update(journalData, { recursive: false });
        await this.reconcileJournalPages(existing, journalData);
      } else {
        await JournalEntry.create(journalData, { pack: this.PACK_ID, keepId: true });
      }

      // Update local syncedAt to match (do not touch localModifiedAt).
      await journal.update(
        { 'flags.omnipresence.syncedAt': syncedAt },
        { omnipresenceInternal: true }
      );
    } catch (err) {
      console.error('Omnipresence | journal push failed for', journal.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: journal.name })
      );
    }
  }

  static debouncedPush(journal) {
    const id = journal.id;
    if (this._timers.has(id)) clearTimeout(this._timers.get(id));
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this.push(journal);
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

  static async trackLocalModification(journal) {
    await journal.update(
      { 'flags.omnipresence.localModifiedAt': new Date().toISOString() },
      { omnipresenceInternal: true }
    );
  }

  /**
   * Route a page change to the owning enrolled journal: mark dirty (editing
   * user) and debounce a push (GM). Page edits don't fire updateJournalEntry.
   */
  static handlePageChange(page, options, userId) {
    if (options?.omnipresenceInternal) return;
    // Compendium copies fire these hooks too (our own pushes) — never treat a
    // pack doc as a local enrolled doc, or the push feeds back on itself.
    if (page.pack) return;
    const journal = resolveOwningJournal(page);
    if (!journal) return;
    if (!SyncRegistry.isEnrolled(journal)) return;
    if (!SyncRegistry.isJournalSyncEnabled(userId)) return;
    if (userId === game.user.id) this.trackLocalModification(journal);
    if (game.user.isGM) this.debouncedPush(journal);
  }

  /**
   * Route a map-pin (scene Note) change to the journal it points at: mark
   * dirty (editing user) and debounce a push (GM). Mirrors handlePageChange.
   */
  static handleNoteChange(note, options, userId) {
    if (options?.omnipresenceInternal) return;
    if (note.pack) return; // never treat pack docs as local (feedback-loop guard)
    const journal = note.entryId ? game.journal.get(note.entryId) : null;
    if (!journal) return;
    if (!SyncRegistry.isEnrolled(journal)) return;
    if (!SyncRegistry.isJournalSyncEnabled(userId)) return;
    if (userId === game.user.id) this.trackLocalModification(journal);
    if (game.user.isGM) this.debouncedPush(journal);
  }

  /**
   * Make target's pages match snapshotData.pages (matched by _id). Page-level
   * ownership is dropped from both sides of the diff so re-applying a local
   * ownership never registers as a change (avoids perpetual churn). Creates use
   * keepId so page _ids stay stable across worlds (the cross-world match key).
   */
  static async reconcileJournalPages(target, snapshotData) {
    const collection = target.getEmbeddedCollection('JournalEntryPage');
    const localDocs = collection.map(d => {
      const o = d.toObject();
      delete o.ownership;
      return o;
    });
    const snapshotDocs = (snapshotData.pages ?? []).map(p => {
      const c = structuredClone(p);
      delete c.ownership;
      return c;
    });
    const { toCreate, toUpdate, toDelete } = diffEmbedded(localDocs, snapshotDocs);

    if (toDelete.length) {
      await target.deleteEmbeddedDocuments('JournalEntryPage', toDelete, { omnipresenceInternal: true });
    }
    if (toCreate.length) {
      await target.createEmbeddedDocuments('JournalEntryPage', toCreate, {
        keepId: true,
        omnipresenceInternal: true
      });
    }
    if (toUpdate.length) {
      await target.updateEmbeddedDocuments('JournalEntryPage', toUpdate, { omnipresenceInternal: true, recursive: false });
    }
  }

  /**
   * Mirror this journal's map pins onto same-named local scenes (GM-only —
   * scene writes need GM permission). Processes the UNION of payload scene
   * names and local scenes currently holding this journal's pins, so pin
   * removals (and scenes dropped from the payload) mirror too. Notes
   * belonging to other journals are never touched. Per-scene failures are
   * isolated.
   */
  static async _applyPins(journal, pins) {
    if (!game.user.isGM) return;
    const localized = localizePins(pins, journal.id);

    const byScene = new Map();
    for (const pin of localized) {
      if (!byScene.has(pin.sceneName)) byScene.set(pin.sceneName, []);
      byScene.get(pin.sceneName).push(pin.note);
    }
    const names = new Set(byScene.keys());
    for (const scene of game.scenes) {
      if (scene.notes.some(n => n.entryId === journal.id)) names.add(scene.name);
    }

    for (const name of names) {
      const scene = game.scenes.getName(name); // first match by name
      if (!scene) continue; // no matching scene here — heals at a later login
      try {
        const localDocs = scene.notes
          .filter(n => n.entryId === journal.id)
          .map(n => n.toObject());
        const { toCreate, toUpdate, toDelete } =
          diffEmbedded(localDocs, byScene.get(name) ?? []);
        if (toDelete.length) {
          await scene.deleteEmbeddedDocuments('Note', toDelete, { omnipresenceInternal: true });
        }
        if (toCreate.length) {
          await scene.createEmbeddedDocuments('Note', toCreate, {
            keepId: true,
            omnipresenceInternal: true
          });
        }
        if (toUpdate.length) {
          await scene.updateEmbeddedDocuments('Note', toUpdate, {
            omnipresenceInternal: true,
            recursive: false
          });
        }
      } catch (err) {
        console.error('Omnipresence | pin apply failed on scene', name, 'for', journal.name, err);
      }
    }
  }

  /**
   * Phase-2 login heal: re-mirror every enrolled journal's pin payload, so
   * pins whose scene or journal arrived after the journal's own pull resolve.
   * Pack copies without a pins flag (pushed by older versions) are skipped —
   * undefined means "never captured", not "no pins".
   */
  static async applyAllPins() {
    if (!game.user.isGM) return;
    const pack = this._getPack();
    if (!pack) return;
    if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return;

    const compDocs = await pack.getDocuments();
    for (const journal of game.journal.filter(j => SyncRegistry.isEnrolled(j))) {
      const omniId = journal.getFlag('omnipresence', 'id');
      const comp = compDocs.find(d => d.getFlag('omnipresence', 'id') === omniId);
      const pins = comp?.getFlag('omnipresence', 'pins');
      if (pins === undefined) continue;

      // Never mirror pins onto a journal whose sync is in unresolved conflict —
      // that would apply part of the remote state (and delete local pin
      // changes) before the user chooses a resolution.
      const action = decideSyncAction({
        localSyncedAt: journal.getFlag('omnipresence', 'syncedAt'),
        compSyncedAt: comp.getFlag('omnipresence', 'syncedAt'),
        localModifiedAt: journal.getFlag('omnipresence', 'localModifiedAt')
      });
      if (action === 'conflict') continue;

      try {
        await this._applyPins(journal, pins);
      } catch (err) {
        console.error('Omnipresence | pin apply failed for', journal.name, err);
      }
    }
  }

  static async pull(localJournal, compJournal) {
    // Strip world-local fields so local ownership and folder are preserved,
    // and localize canonical omnipresence ids to this world's ids.
    const journalData = LinkRewriter.localize(
      this._stripPageOwnership(stripWorldLocalFields(compJournal.toObject()))
    );
    journalData.flags ??= {};
    journalData.flags.omnipresence ??= {};
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding).
    journalData.flags.omnipresence.localModifiedAt = journalData.flags.omnipresence.syncedAt;
    // The pin payload lives only on pack copies — extract it for apply (Task
    // 3) and keep it off the local journal.
    const pins = journalData.flags.omnipresence.pins;
    delete journalData.flags.omnipresence.pins;
    try {
      await localJournal.update(journalData, { omnipresenceInternal: true, recursive: false });
      await this.reconcileJournalPages(localJournal, journalData);
      if (pins !== undefined) await this._applyPins(localJournal, pins);
    } catch (err) {
      console.error('Omnipresence | journal pull failed for', localJournal.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: localJournal.name })
      );
    }
  }

  static async onLogin() {
    const pack = this._getPack();
    if (!pack) return;

    if (!SyncRegistry.isJournalSyncEnabled(game.user.id)) return;

    const compJournals = await pack.getDocuments();
    const myJournals = game.journal.filter(j => j.isOwner && SyncRegistry.isEnrolled(j));

    const touched = [];
    const conflicts = [];

    // 1. Sync each of the current user's enrolled journals.
    for (const journal of myJournals) {
      const omnipresenceId = journal.getFlag('omnipresence', 'id');
      const compJournal = compJournals.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);

      if (!compJournal) {
        await this.push(journal);
        touched.push(journal);
        continue;
      }

      const action = decideSyncAction({
        localSyncedAt: journal.getFlag('omnipresence', 'syncedAt'),
        compSyncedAt: compJournal.getFlag('omnipresence', 'syncedAt'),
        localModifiedAt: journal.getFlag('omnipresence', 'localModifiedAt')
      });

      if (action === 'conflict') {
        conflicts.push(journal.id);
      } else if (action === 'pull') {
        await this.pull(journal, compJournal);
      } else if (action === 'push') {
        await this.push(journal);
      }
      touched.push(journal);
    }

    // 2. Auto-import: compendium journals not present in this world (GM only).
    if (game.user.isGM) {
      const localOmnipresenceIds = new Set(
        game.journal
          .filter(j => SyncRegistry.isEnrolled(j))
          .map(j => j.getFlag('omnipresence', 'id'))
      );

      for (const compJournal of compJournals) {
        const omnipresenceId = compJournal.getFlag('omnipresence', 'id');
        if (!omnipresenceId) continue;
        if (localOmnipresenceIds.has(omnipresenceId)) continue;

        const ownerName = compJournal.getFlag('omnipresence', 'ownerName');
        if (!ownerName) {
          console.warn('Omnipresence | compendium journal has no ownerName, skipping auto-import:', compJournal.name);
          continue;
        }

        const matchingUser = game.users.find(u => u.name === ownerName);
        if (!matchingUser) {
          console.warn('Omnipresence | no user named', ownerName, '— skipping auto-import of', compJournal.name);
          continue;
        }

        const journalData = LinkRewriter.localize(
          this._stripPageOwnership(stripWorldLocalFields(compJournal.toObject()))
        );
        journalData.flags ??= {};
        journalData.flags.omnipresence ??= {};
        journalData.flags.omnipresence.localModifiedAt = journalData.flags.omnipresence.syncedAt;
        const pins = journalData.flags.omnipresence.pins;
        delete journalData.flags.omnipresence.pins;
        journalData.ownership = { default: 0, [matchingUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

        const created = await JournalEntry.create(journalData, { keepId: true });
        await SyncRegistry.enroll(created);
        if (pins !== undefined) await this._applyPins(created, pins);
        touched.push(created);
      }
    }

    this._warnMissingFidelity(touched);

    return conflicts;
  }

  /**
   * Emit at most one consolidated warning listing modules a world is missing for
   * full journal fidelity, plus a note if any synced media use world-local paths.
   */
  static _warnMissingFidelity(journals) {
    const missingModules = new Set();
    let hasWorldLocalMedia = false;

    for (const journal of journals) {
      const data = journal.toObject();
      for (const id of requiredModulesForJournal(data)) {
        if (id === game.system.id) continue;
        if (!game.modules.get(id)?.active) missingModules.add(id);
      }
      if (worldLocalMediaPaths(data).length > 0) hasWorldLocalMedia = true;
    }

    const parts = [];
    if (missingModules.size > 0) {
      parts.push(game.i18n.format('OMNIPRESENCE.notifications.missingModules', {
        modules: [...missingModules].sort().join(', ')
      }));
    }
    if (hasWorldLocalMedia) {
      parts.push(game.i18n.localize('OMNIPRESENCE.notifications.worldLocalMedia'));
    }
    if (parts.length > 0) ui.notifications.warn(parts.join(' '));
  }
}
