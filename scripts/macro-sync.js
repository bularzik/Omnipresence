import { SyncRegistry } from './sync-registry.js';

const DEBOUNCE_MS = 2000;

export class MacroSync {
  static _timers = new Map(); // userId → timeout handle

  static get PACK_ID() {
    return 'omnipresence.omnipresence-macros';
  }

  static _getPack() {
    return game.packs.get(this.PACK_ID);
  }

  /** Opted-in users who have `macroId` in their hotbar. */
  static _getUsersWithMacro(macroId) {
    return game.users.filter(u =>
      SyncRegistry.isMacroSyncEnabled(u.id) &&
      Object.values(u.hotbar).includes(macroId)
    );
  }

  static async pushForUser(user) {
    if (!game.user.isGM) return;
    if (!SyncRegistry.isMacroSyncEnabled(user.id)) return;

    const pack = this._getPack();
    if (!pack) return;

    // Build macroId → slots[] from the user's hotbar.
    const macroSlots = new Map();
    for (const [slot, macroId] of Object.entries(user.hotbar)) {
      if (!macroId) continue;
      const slots = macroSlots.get(macroId) ?? [];
      slots.push(Number(slot));
      macroSlots.set(macroId, slots);
    }

    // Load existing compendium entries for this user.
    const compDocs = await pack.getDocuments();
    const userCompDocs = compDocs.filter(d =>
      d.getFlag('omnipresence', 'ownerName') === user.name
    );
    const compByOmpId = new Map(
      userCompDocs.map(d => [d.getFlag('omnipresence', 'id'), d])
    );

    const pushedOmpIds = new Set();

    for (const [macroId, slots] of macroSlots) {
      const macro = game.macros.get(macroId);
      if (!macro) continue;

      // Stamp a stable omnipresence.id on the local doc if it lacks one.
      let ompId = macro.getFlag('omnipresence', 'id');
      if (!ompId) {
        ompId = foundry.utils.randomID(16);
        await macro.update(
          { 'flags.omnipresence.id': ompId },
          { omnipresenceInternal: true }
        );
      }

      const macroData = macro.toObject();
      delete macroData._id;
      delete macroData.folder;
      delete macroData.ownership;
      macroData.flags ??= {};
      macroData.flags.omnipresence = { id: ompId, ownerName: user.name, hotbarSlots: slots };

      const existing = compByOmpId.get(ompId);
      if (existing) {
        await existing.update(macroData);
      } else {
        await Macro.create(macroData, { pack: this.PACK_ID });
      }
      pushedOmpIds.add(ompId);
    }

    // Delete compendium entries for macros no longer on this user's hotbar.
    for (const doc of userCompDocs) {
      if (!pushedOmpIds.has(doc.getFlag('omnipresence', 'id'))) {
        await doc.delete();
      }
    }
  }

  static debouncedPushForUser(user) {
    const id = user.id;
    if (this._timers.has(id)) clearTimeout(this._timers.get(id));
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this.pushForUser(user);
    }, DEBOUNCE_MS);
    this._timers.set(id, timer);
  }

  static handleMacroChange(macro) {
    if (!game.user.isGM) return;
    for (const user of this._getUsersWithMacro(macro.id)) {
      this.debouncedPushForUser(user);
    }
  }

  static handleHotbarChange(user) {
    if (!game.user.isGM) return;
    if (!SyncRegistry.isMacroSyncEnabled(user.id)) return;
    this.debouncedPushForUser(user);
  }

  static async onLogin() {
    const pack = this._getPack();
    if (!pack) return;

    // GM: push all users' hotbars to catch up changes made while GM was offline.
    if (game.user.isGM) {
      for (const user of game.users) {
        if (SyncRegistry.isMacroSyncEnabled(user.id)) {
          await this.pushForUser(user);
        }
      }
    }

    if (!SyncRegistry.isMacroSyncEnabled(game.user.id)) return;

    const compDocs = await pack.getDocuments();
    const myDocs = compDocs.filter(d =>
      d.getFlag('omnipresence', 'ownerName') === game.user.name
    );
    if (myDocs.length === 0) return;

    const localById = new Map(
      game.macros
        .filter(m => m.getFlag('omnipresence', 'id'))
        .map(m => [m.getFlag('omnipresence', 'id'), m])
    );

    const newHotbarEntries = {};

    for (const compMacro of myDocs) {
      const ompId = compMacro.getFlag('omnipresence', 'id');
      const slots = compMacro.getFlag('omnipresence', 'hotbarSlots') ?? [];

      const macroData = compMacro.toObject();
      delete macroData._id;
      delete macroData.folder;

      let localMacro = localById.get(ompId);
      try {
        if (localMacro) {
          await localMacro.update(macroData, { omnipresenceInternal: true });
        } else {
          localMacro = await Macro.create(macroData);
        }
      } catch (err) {
        console.error('Omnipresence | macro pull failed for', compMacro.name, err);
        continue;
      }

      for (const slot of slots) {
        newHotbarEntries[slot] = localMacro.id;
      }
    }

    if (Object.keys(newHotbarEntries).length > 0) {
      await game.user.update(
        { hotbar: { ...game.user.hotbar, ...newHotbarEntries } },
        { omnipresenceInternal: true }
      );
    }
  }
}
