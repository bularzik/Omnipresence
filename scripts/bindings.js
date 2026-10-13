import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { JournalSync } from './journal-sync.js';
import {
  decidePushBinding, buildBindings, resolveDuplicateBindings, pullAllowed, mergeDuplicateRecord, pushRefusalRecord,
  resolveUpgradeDuplicate
} from './security-logic.js';

// The sync flags a detached document loses: without its omni id it is an
// ordinary local document again, and enrolling it later stamps a fresh id
// (SyncRegistry.enroll only creates one when the flag is missing).
const DETACH_FLAGS = ['id', 'enrolled', 'viaFolder', 'wasIndividual', 'pendingEnter', 'pendingRemove'];

/**
 * Shared-copy bindings (#1, #2, #6): which local document in THIS world may
 * write each shared copy, by omni id. Flags on a document are writable by
 * its owner, so `flags.omnipresence.id` alone proves nothing; the binding
 * lives in a world setting only a GM can write.
 */
export class Bindings {
  static SETTING = 'bindings';
  static BUILT = 'bindingsBuilt';
  static DUPLICATES = 'bindingDuplicates';
  static PACK_REMOVALS = 'pendingPackRemovals';

  // Pending writes, visible to get() before the setting round-trips, and the
  // queue that serializes read-modify-write so parallel pushes (Force Sync
  // All) never drop each other's binding.
  static _pending = {};
  static _writes = Promise.resolve();

  static register() {
    game.settings.register('omnipresence', this.SETTING, {
      name: 'Shared copy bindings', scope: 'world', config: false, type: Object, default: {}
    });
    game.settings.register('omnipresence', this.BUILT, {
      name: 'Shared copy bindings built', scope: 'world', config: false, type: Boolean, default: false
    });
    game.settings.register('omnipresence', this.DUPLICATES, {
      name: 'Duplicate sync ids', scope: 'world', config: false, type: Object, default: {}
    });
    // GM-only retry queue for folder-member pack removals that failed: a world
    // setting players cannot write, unlike a flag on a journal they own.
    game.settings.register('omnipresence', this.PACK_REMOVALS, {
      name: 'Pending pack removals', scope: 'world', config: false, type: Array, default: []
    });
  }

  static getAll() {
    return { ...(game.settings.get('omnipresence', this.SETTING) ?? {}), ...this._pending };
  }

  static get(omniId) {
    return omniId ? this.getAll()[omniId] ?? null : null;
  }

  /** Whether `doc` is the document its omni id is bound to here. */
  static isBoundTo(doc) {
    const b = this.get(doc.getFlag('omnipresence', 'id'));
    return !!b && b.type === doc.documentName && b.id === doc.id;
  }

  /**
   * The pull rule for `doc` whose shared copy exists, used by every path that
   * writes a shared copy into a local document (login reconcile, the pulls
   * in SyncEngine/JournalSync, the pin heal). When refused, warn and — the
   * active GM only: players cannot write world settings, and a second GM
   * would race it — list the id in the dashboard's duplicates section.
   */
  static async mayPull(doc) {
    const omniId = doc.getFlag('omnipresence', 'id');
    const ok = pullAllowed({
      bindingsBuilt: !!game.settings.get('omnipresence', this.BUILT),
      binding: this.get(omniId), docId: doc.id, docType: doc.documentName
    });
    if (ok) return true;
    console.warn(
      `Omnipresence | refusing to sync ${doc.documentName} "${doc.name}" (${doc.id}) from its shared copy: ` +
      `its sync id ${omniId} is not bound to it here.`
    );
    if (SyncRegistry.isPusher() && !this.get(omniId)) {
      await this._recordDuplicate(omniId, [{ type: doc.documentName, id: doc.id }, { type: 'SharedCopy', id: omniId }]);
    }
    return false;
  }

  /** GM only. Apply `entries` ({omniId: {type, id}}) to the setting, one write at a time. */
  static _write(entries) {
    if (!game.user.isGM || !Object.keys(entries).length) return Promise.resolve();
    Object.assign(this._pending, entries);
    const run = this._writes.then(async () => {
      const next = { ...(game.settings.get('omnipresence', this.SETTING) ?? {}), ...entries };
      try {
        await game.settings.set('omnipresence', this.SETTING, next);
      } catch (err) {
        // Never proceed on a binding that was not saved.
        for (const key of Object.keys(entries)) {
          if (this._pending[key] === entries[key]) delete this._pending[key];
        }
        throw err;
      }
      for (const key of Object.keys(entries)) {
        if (this._pending[key] === entries[key]) delete this._pending[key];
      }
    });
    this._writes = run.catch(err => console.error('Omnipresence | binding write failed', err));
    return run;
  }

  /** Bind `doc` as the owner of its omni id here (a GM import, or a new enrollment's first push). */
  static bind(doc) {
    const omniId = doc.getFlag('omnipresence', 'id');
    if (!omniId) return Promise.resolve();
    return this._write({ [omniId]: { type: doc.documentName, id: doc.id } });
  }

  /** The push check: may `doc` write (or delete) the shared copy of its omni id? */
  static async authorizePush(doc, copyExists) {
    const omniId = doc.getFlag('omnipresence', 'id');
    const others = this._carriers().filter(c => c.omniId === omniId && !(c.type === doc.documentName && c.id === doc.id));
    const decision = decidePushBinding({
      binding: this.get(omniId), docType: doc.documentName, docId: doc.id, copyExists,
      otherCarrier: others.length > 0
    });
    if (decision === 'proceed') return true;
    if (decision === 'bind') {
      await this.bind(doc);
      return true;
    }
    const record = pushRefusalRecord({
      omniId, bound: !!this.get(omniId), copyExists,
      doc: { type: doc.documentName, id: doc.id }, others
    });
    if (record) await this._recordDuplicate(omniId, record);
    console.warn(
      `Omnipresence | refusing to sync ${doc.documentName} "${doc.name}" (${doc.id}): ` +
      `its sync id ${omniId} belongs to another document. If both are legitimate copies, ` +
      'remove one from sync in the Omnipresence dashboard.'
    );
    return false;
  }

  /**
   * GM only: list an unbound id for the dashboard and resolveDuplicates.
   * Merges into an existing record, so a SharedCopy marker is never dropped.
   * @param {string} omniId
   * @param {Array<{type: string, id: string}>} docs
   */
  static async _recordDuplicate(omniId, docs) {
    if (!game.user.isGM) return;
    const recorded = { ...(game.settings.get('omnipresence', this.DUPLICATES) ?? {}) };
    const merged = mergeDuplicateRecord(recorded[omniId], docs);
    if (JSON.stringify(merged) === JSON.stringify(recorded[omniId])) return;
    recorded[omniId] = merged;
    await game.settings.set('omnipresence', this.DUPLICATES, recorded);
  }

  /** Every local document carrying an omni id, as binding carriers. */
  static _carriers() {
    const out = [];
    const add = (doc, type, enrolled) => {
      const omniId = doc.getFlag('omnipresence', 'id');
      if (omniId) out.push({ omniId, type, id: doc.id, enrolled });
    };
    for (const a of game.actors) add(a, 'Actor', SyncRegistry.isEnrolled(a));
    for (const j of game.journal) add(j, 'JournalEntry', SyncRegistry.isEnrolled(j));
    // Synced folders are structural: they count as enrolled while they exist.
    for (const f of game.folders) if (f.type === 'JournalEntry') add(f, 'Folder', true);
    return out;
  }

  /**
   * Active GM, at ready: build the bindings from this world's documents on
   * the first login after the upgrade, then settle recorded duplicates.
   */
  static async init() {
    if (!SyncRegistry.isPusher()) return;
    if (!game.settings.get('omnipresence', this.BUILT)) await this.build();
    await this.resolveDuplicates();
    await this.sweepInheritedIds();
  }

  /**
   * Bind every omni id carried by exactly one document. Ids carried by two
   * or more stay unbound (their pushes are refused) and are listed in the
   * dashboard, because a pre-upgrade forgery looks exactly like this —
   * except a set the shared copy's owner settles (_resolveUpgradeDuplicates).
   * Runs once per world: never after `bindingsBuilt`.
   */
  static async build() {
    if (game.settings.get('omnipresence', this.BUILT)) return;
    const { bindings, duplicates } = buildBindings(this._carriers());
    const existing = game.settings.get('omnipresence', this.SETTING) ?? {};
    const fresh = Object.fromEntries(Object.entries(bindings).filter(([k]) => !(k in existing)));
    await this._write(fresh);
    await game.settings.set('omnipresence', this.DUPLICATES, duplicates);
    const detached = await this._resolveUpgradeDuplicates(Object.keys(duplicates));
    await game.settings.set('omnipresence', this.BUILT, true);
    if (detached.length) {
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.upgradeDetached', { names: detached.map(d => d.name).join(', ') }),
        { permanent: true }
      );
    }
    const n = Object.keys(game.settings.get('omnipresence', this.DUPLICATES) ?? {}).length;
    if (n) console.warn(`Omnipresence | ${n} sync id(s) are carried by more than one document; see the Omnipresence dashboard.`);
  }

  /**
   * One-time upgrade only (called from build): an honest world can already
   * hold several documents with one omni id — a Foundry Duplicate of an
   * enrolled document copies its flags. Left listed, the login pull marks
   * them SharedCopy and they never sync again. Decide by the carriers' real
   * ownership (resolveUpgradeDuplicate rules A and B) — never by the shared
   * copy's ownerName, which a forger's pre-upgrade push re-stamped — and
   * detach the rest. After the build, new duplicates go through the create
   * hook and ready sweep (clearInheritedId / sweepInheritedIds) and the
   * dashboard's Keep action instead.
   * @param {string[]} omniIds the ids build() found duplicated
   * @returns {Promise<Array>} the detached documents
   */
  static async _resolveUpgradeDuplicates(omniIds) {
    if (!omniIds.length) return [];
    const carriers = this._carriers();
    const users = game.users.map(u => ({ id: u.id, isGM: u.isGM }));
    const copies = {};
    const copyFor = async (type, omniId) => {
      const pack = game.packs.get(type === 'Actor' ? SyncEngine.PACK_ID : JournalSync.PACK_ID);
      copies[type] ??= pack ? await pack.getDocuments() : [];
      return copies[type].find(d => d.getFlag('omnipresence', 'id') === omniId) ?? null;
    };
    const detached = [];
    for (const omniId of omniIds) {
      try {
        const docs = carriers.filter(c => c.omniId === omniId);
        if (docs.some(c => c.type !== 'Actor' && c.type !== 'JournalEntry')) continue;
        // The copy only supplies the last-push timestamp (rule A's tie-break).
        let copy = null;
        for (const type of ['Actor', 'JournalEntry']) {
          if (copy || !docs.some(c => c.type === type)) continue;
          const found = await copyFor(type, omniId);
          if (found) copy = { type, syncedAt: found.getFlag('omnipresence', 'syncedAt') ?? null };
        }
        const { keep } = resolveUpgradeDuplicate({
          copy,
          users,
          carriers: docs.map(c => {
            const doc = this._lookup(c.type, c.id);
            return {
              type: c.type, id: c.id, enrolled: c.enrolled,
              ownership: { ...(doc.ownership ?? {}) },
              lastSyncedAt: doc.getFlag('omnipresence', 'syncedAt') ?? null,
              createdTime: doc._stats?.createdTime ?? null
            };
          })
        });
        if (keep) detached.push(...await this.keep(omniId, keep));
      } catch (err) {
        console.error('Omnipresence | upgrade duplicate resolve failed for', omniId, err);
      }
    }
    return detached;
  }

  /** The local Actor, JournalEntry or Folder a carrier/binding names, or null. */
  static _lookup(type, id) {
    if (type === 'Actor') return game.actors.get(id) ?? null;
    if (type === 'JournalEntry') return game.journal.get(id) ?? null;
    if (type === 'Folder') return game.folders.get(id) ?? null;
    return null;
  }

  /** Take `doc` out of sync for good: drop its omni id and enrollment flags. */
  static _detach(doc) {
    const update = Object.fromEntries(DETACH_FLAGS.map(k => [`flags.omnipresence.-=${k}`, null]));
    return doc.update(update, { omnipresenceInternal: true });
  }

  /**
   * GM: make `target` ({type, id}) the document bound to `omniId`, take
   * every other local Actor/JournalEntry carrier of the id out of sync, drop
   * the id's duplicates record and put the kept document back on its gate
   * user's allow-list. The dashboard's "Keep this one" and the one-time
   * upgrade both settle a duplicate through here.
   * @returns {Promise<Array>} the detached documents
   */
  static async keep(omniId, target) {
    if (!game.user.isGM) return [];
    const doc = this._lookup(target.type, target.id);
    if (!doc || doc.getFlag('omnipresence', 'id') !== omniId) return [];
    const others = this._carriers().filter(c =>
      c.omniId === omniId && (c.type === 'Actor' || c.type === 'JournalEntry') &&
      !(c.type === target.type && c.id === target.id));
    const detached = [];
    for (const c of others) {
      const other = this._lookup(c.type, c.id);
      if (!other) continue;
      await this._detach(other);
      detached.push(other);
    }
    await this._write({ [omniId]: { type: target.type, id: target.id } });
    const recorded = { ...(game.settings.get('omnipresence', this.DUPLICATES) ?? {}) };
    if (omniId in recorded) {
      delete recorded[omniId];
      await game.settings.set('omnipresence', this.DUPLICATES, recorded);
    }
    await this._readmit(omniId, target);
    return detached;
  }

  /**
   * Put a newly bound document back on its gate user's allow-list.
   * Unenrolling (or detaching) the other carriers removed the shared omni id
   * from that list (unenroll is keyed by omni id) — without this its pushes
   * work but login reconcile would skip it.
   */
  static async _readmit(omniId, { type, id }) {
    const doc = type === 'Actor' || type === 'JournalEntry' ? this._lookup(type, id) : null;
    // Folders and folder members are gated by their root's folderIds entry, not one by one.
    if (!doc || doc.getFlag('omnipresence', 'viaFolder')) return;
    // Real ownership, not the owner-writable ownerName flag.
    const gate = SyncRegistry.gateUser(SyncRegistry.resolveOwnerName(doc));
    if (gate) await SyncRegistry.addToSelection(gate.id, type === 'Actor' ? 'actor' : 'journal', omniId);
  }

  /**
   * Active GM, createActor/createJournalEntry: a new document must never
   * inherit an omni id bound to another document that still exists here —
   * Foundry's Duplicate copies every flag, and so does a hand import. Clear
   * the id and enrollment flags so the copy is an ordinary document (enroll
   * it to share it as its own). Internal creates (GM imports, which bind
   * the new document) pass `omnipresenceInternal` and are left alone.
   */
  static async clearInheritedId(doc, options) {
    if (options?.omnipresenceInternal || doc.pack) return;
    if (!SyncRegistry.isPusher()) return;
    if (!game.settings.get('omnipresence', this.BUILT)) return;
    await this._detachIfInherited(doc);
  }

  /**
   * Active GM, at ready (after the build): the same clearing for every
   * existing Actor/JournalEntry carrying an id bound to a different document
   * that still exists — copies made while no GM was connected, which the
   * create hook never saw.
   */
  static async sweepInheritedIds() {
    if (!SyncRegistry.isPusher()) return;
    if (!game.settings.get('omnipresence', this.BUILT)) return;
    for (const doc of [...game.actors, ...game.journal]) {
      try {
        await this._detachIfInherited(doc);
      } catch (err) {
        console.error('Omnipresence | clearing an inherited sync id failed for', doc.name, err);
      }
    }
  }

  /** Detach `doc` when its omni id is bound to a different document that still exists here. */
  static async _detachIfInherited(doc) {
    const omniId = doc.getFlag('omnipresence', 'id');
    if (!omniId) return false;
    const bound = this.get(omniId);
    if (!bound || (bound.type === doc.documentName && bound.id === doc.id)) return false;
    if (!this._lookup(bound.type, bound.id)) return false;
    await this._detach(doc);
    console.info(`Omnipresence | cleared the sync id carried by ${doc.documentName} "${doc.name}" (${doc.id}): ${omniId} belongs to another document.`);
    return true;
  }

  /**
   * GM: bind a duplicate once exactly one enrolled carrier is left; drop ones
   * with none, and put the survivor back on its gate user's allow-list.
   */
  static async resolveDuplicates() {
    if (!game.user.isGM) return;
    const recorded = game.settings.get('omnipresence', this.DUPLICATES) ?? {};
    if (!Object.keys(recorded).length) return;
    const { bind, remaining } = resolveDuplicateBindings(recorded, this._carriers());
    await this._write(bind);
    await game.settings.set('omnipresence', this.DUPLICATES, remaining);
    for (const [omniId, target] of Object.entries(bind)) await this._readmit(omniId, target);
  }

  /**
   * Dashboard rows for the recorded duplicates, with document names. Each
   * local Actor/JournalEntry that still carries the id can be kept.
   */
  static duplicateRows() {
    const recorded = game.settings.get('omnipresence', this.DUPLICATES) ?? {};
    return Object.entries(recorded).map(([omniId, docs]) => ({
      omniId,
      sharedCopy: docs.some(d => d.type === 'SharedCopy'),
      docs: docs.map(({ type, id }) => {
        if (type === 'SharedCopy') {
          return { type: game.i18n.localize('OMNIPRESENCE.dashboard.sharedCopy'), name: game.i18n.localize('OMNIPRESENCE.dashboard.sharedCopyName') };
        }
        const doc = this._lookup(type, id);
        const keepable = (type === 'Actor' || type === 'JournalEntry') && doc?.getFlag('omnipresence', 'id') === omniId;
        return { type, id, omniId, name: doc?.name ?? id, keepable };
      })
    }));
  }
}
