import { SyncRegistry } from './sync-registry.js';
import { decidePushBinding, buildBindings, resolveDuplicateBindings } from './security-logic.js';

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

  /** GM only. Apply `entries` ({omniId: {type, id}}) to the setting, one write at a time. */
  static _write(entries) {
    if (!game.user.isGM || !Object.keys(entries).length) return Promise.resolve();
    Object.assign(this._pending, entries);
    const run = this._writes.then(async () => {
      const next = { ...(game.settings.get('omnipresence', this.SETTING) ?? {}), ...entries };
      await game.settings.set('omnipresence', this.SETTING, next);
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
    const decision = decidePushBinding({
      binding: this.get(omniId), docType: doc.documentName, docId: doc.id, copyExists
    });
    if (decision === 'proceed') return true;
    if (decision === 'bind') {
      await this.bind(doc);
      return true;
    }
    console.warn(
      `Omnipresence | refusing to sync ${doc.documentName} "${doc.name}" (${doc.id}): ` +
      `its sync id ${omniId} belongs to another document. If both are legitimate copies, ` +
      'remove one from sync in the Omnipresence dashboard.'
    );
    return false;
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
  }

  /**
   * Bind every omni id carried by exactly one document. Ids carried by two
   * or more stay unbound (their pushes are refused) and are listed in the
   * dashboard, because a pre-upgrade forgery looks exactly like this.
   */
  static async build() {
    const { bindings, duplicates } = buildBindings(this._carriers());
    const existing = game.settings.get('omnipresence', this.SETTING) ?? {};
    const fresh = Object.fromEntries(Object.entries(bindings).filter(([k]) => !(k in existing)));
    await this._write(fresh);
    await game.settings.set('omnipresence', this.DUPLICATES, duplicates);
    await game.settings.set('omnipresence', this.BUILT, true);
    const n = Object.keys(duplicates).length;
    if (n) console.warn(`Omnipresence | ${n} sync id(s) are carried by more than one document; see the Omnipresence dashboard.`);
  }

  /**
   * GM: bind a duplicate once exactly one enrolled carrier is left; drop ones
   * with none. Unenrolling the other carriers removed the shared omni id from
   * the gate user's allow-list (unenroll is keyed by omni id), so put the
   * survivor back on it — otherwise its pushes work but login reconcile
   * would skip it.
   */
  static async resolveDuplicates() {
    if (!game.user.isGM) return;
    const recorded = game.settings.get('omnipresence', this.DUPLICATES) ?? {};
    if (!Object.keys(recorded).length) return;
    const { bind, remaining } = resolveDuplicateBindings(recorded, this._carriers());
    await this._write(bind);
    await game.settings.set('omnipresence', this.DUPLICATES, remaining);
    for (const [omniId, { type, id }] of Object.entries(bind)) {
      const doc = type === 'Actor' ? game.actors.get(id) : type === 'JournalEntry' ? game.journal.get(id) : null;
      // Folders and folder members are gated by their root's folderIds entry, not one by one.
      if (!doc || doc.getFlag('omnipresence', 'viaFolder')) continue;
      const gate = SyncRegistry.gateUser(doc.getFlag('omnipresence', 'ownerName') ?? null);
      if (gate) await SyncRegistry.addToSelection(gate.id, type === 'Actor' ? 'actor' : 'journal', omniId);
    }
  }

  /** Dashboard rows for the recorded duplicates, with document names. */
  static duplicateRows() {
    const recorded = game.settings.get('omnipresence', this.DUPLICATES) ?? {};
    const lookup = {
      Actor: id => game.actors.get(id),
      JournalEntry: id => game.journal.get(id),
      Folder: id => game.folders.get(id)
    };
    return Object.entries(recorded).map(([omniId, docs]) => ({
      omniId,
      docs: docs.map(({ type, id }) => ({ type, name: lookup[type]?.(id)?.name ?? id }))
    }));
  }
}
