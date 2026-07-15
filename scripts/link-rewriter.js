import { SyncRegistry } from './sync-registry.js';
import { canonicalizeLinks, localizeLinks } from './sync-logic.js';

/**
 * Builds local↔omni id maps over enrolled actors + journals and drives the
 * pure link transforms. The pack stores canonical omnipresence ids; each
 * world holds a localized copy.
 */
export class LinkRewriter {
  static _enrolledDocs() {
    return [
      ...game.actors.filter(a => SyncRegistry.isEnrolled(a)),
      ...game.journal.filter(j => SyncRegistry.isEnrolled(j))
    ];
  }

  static buildLocalToOmni() {
    const map = new Map();
    for (const doc of this._enrolledDocs()) {
      const omniId = doc.getFlag('omnipresence', 'id');
      if (omniId) map.set(doc.id, omniId);
    }
    return map;
  }

  static buildOmniToLocal() {
    const map = new Map();
    for (const doc of this._enrolledDocs()) {
      const omniId = doc.getFlag('omnipresence', 'id');
      if (omniId) map.set(omniId, doc.id);
    }
    return map;
  }

  static canonicalize(data) {
    return canonicalizeLinks(data, this.buildLocalToOmni());
  }

  static localize(data) {
    return localizeLinks(data, this.buildOmniToLocal());
  }

  /**
   * Phase-2 login pass: once both engines' onLogin have run, every enrolled
   * doc exists locally, so any canonical omnipresence id left in local data
   * (target imported after the linking doc, or in a previous session) can now
   * resolve. Only docs the current user owns are written (permissions).
   */
  static async localizeAll() {
    const map = this.buildOmniToLocal();
    if (map.size === 0) return;
    const canonicalIds = [...map.keys()];

    for (const journal of game.journal.filter(j => j.isOwner && SyncRegistry.isEnrolled(j))) {
      try {
        await this._localizeJournal(journal, map, canonicalIds);
      } catch (err) {
        console.error('Omnipresence | localize failed for journal', journal.name, err);
      }
    }
    for (const actor of game.actors.filter(a => a.isOwner && SyncRegistry.isEnrolled(a))) {
      try {
        await this._localizeActor(actor, map, canonicalIds);
      } catch (err) {
        console.error('Omnipresence | localize failed for actor', actor.name, err);
      }
    }
  }

  // JSON.stringify equality is valid here because rewriteDeep and the MEJ
  // adapter rebuild objects preserving Object.entries order from the same
  // toObject() source, so key order (and thus stringified form) is stable.
  static _changed(a, b) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }

  /** Embedded docs (matched by _id) whose localized form differs from the original. */
  static _changedById(originals, localizeds) {
    const origById = new Map((originals ?? []).map(d => [d._id, d]));
    return (localizeds ?? []).filter(d => this._changed(origById.get(d._id), d));
  }

  static async _localizeJournal(journal, map, canonicalIds) {
    const original = journal.toObject();
    const raw = JSON.stringify(original);
    if (!canonicalIds.some(id => raw.includes(id))) return; // cheap screen
    const localized = localizeLinks(original, map);

    if (this._changed(original.flags, localized.flags)) {
      await journal.update(
        { flags: localized.flags },
        { omnipresenceInternal: true, diff: false, recursive: false }
      );
    }
    const pages = this._changedById(original.pages, localized.pages);
    if (pages.length) {
      await journal.updateEmbeddedDocuments(
        'JournalEntryPage', pages, { omnipresenceInternal: true, recursive: false }
      );
    }
  }

  static async _localizeActor(actor, map, canonicalIds) {
    const original = actor.toObject();
    const raw = JSON.stringify(original);
    if (!canonicalIds.some(id => raw.includes(id))) return; // cheap screen
    const localized = localizeLinks(original, map);

    if (this._changed(
      { system: original.system, flags: original.flags },
      { system: localized.system, flags: localized.flags }
    )) {
      await actor.update(
        { system: localized.system, flags: localized.flags },
        { omnipresenceInternal: true, diff: false, recursive: false }
      );
    }

    // Items — compared without their nested effects (handled below), because
    // nested embedded updates do not ride through updateEmbeddedDocuments.
    const stripEffects = ({ effects, ...rest }) => rest;
    const items = this._changedById(
      (original.items ?? []).map(stripEffects),
      (localized.items ?? []).map(stripEffects)
    );
    if (items.length) {
      await actor.updateEmbeddedDocuments('Item', items, { omnipresenceInternal: true, recursive: false });
    }

    // Effects nested on items.
    const origItems = new Map((original.items ?? []).map(i => [i._id, i]));
    for (const locItem of localized.items ?? []) {
      const nested = this._changedById(origItems.get(locItem._id)?.effects, locItem.effects);
      if (!nested.length) continue;
      const item = actor.items.get(locItem._id);
      if (item) {
        await item.updateEmbeddedDocuments(
          'ActiveEffect', nested, { omnipresenceInternal: true, recursive: false }
        );
      }
    }

    // Actor-level effects.
    const effects = this._changedById(original.effects, localized.effects);
    if (effects.length) {
      await actor.updateEmbeddedDocuments(
        'ActiveEffect', effects, { omnipresenceInternal: true, recursive: false }
      );
    }
  }
}
