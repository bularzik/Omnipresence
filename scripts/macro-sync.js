import { SyncRegistry } from './sync-registry.js';
import { stripMacroLocalFields } from './sync-logic.js';
import { macroPushDecision, macroCopiesToDelete, decideScriptMacroInstall, sha256Hex } from './security-logic.js';
import { LinkRewriter } from './link-rewriter.js';

const DEBOUNCE_MS = 2000;

export class MacroSync {
  static _timers = new Map(); // userId → timeout handle

  /** Client setting: SHA-256 hashes of script-macro commands this GM approved (#5). */
  static APPROVED_SETTING = 'approvedMacroHashes';

  static registerSettings() {
    game.settings.register('omnipresence', this.APPROVED_SETTING, {
      name: 'Approved script macro hashes', scope: 'client', config: false, type: Array, default: []
    });
  }

  static _approvedHashes() {
    return game.settings.get('omnipresence', this.APPROVED_SETTING) ?? [];
  }

  /** Hash of the pack copy's canonical command — identical in every world, unlike the localized one. */
  static _commandHash(compMacro) {
    return sha256Hex(compMacro._source.command ?? '');
  }

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
    // Slots whose macro no longer exists locally (Foundry never clears a slot
    // when its macro is deleted). The user still wants those: keep their pack
    // copies (matched by the slots recorded on the copy) so the pull phase
    // restores the local macro, instead of deleting the shared copy from
    // every world (op-bhm). Only an explicitly cleared slot removes a copy.
    const danglingSlots = new Set();

    for (const [macroId, slots] of macroSlots) {
      const macro = game.macros.get(macroId);
      const decision = macroPushDecision({
        exists: !!macro,
        ownedByUser: !!macro?.testUserPermission(user, 'OWNER')
      });
      if (decision === 'dangling') {
        for (const slot of slots) danglingSlots.add(slot);
        continue;
      }
      if (decision === 'skip') {
        // A player can put any macro id on their own hotbar; publishing a
        // macro they do not own would leak a GM-only macro under their name (#4).
        console.warn('Omnipresence | not publishing macro', macro.name, 'from the hotbar of', user.name, '— they do not own it');
        continue;
      }

      // Stamp a stable omnipresence.id on the local doc if it lacks one.
      let ompId = macro.getFlag('omnipresence', 'id');
      if (!ompId) {
        ompId = foundry.utils.randomID(16);
        await macro.update(
          { 'flags.omnipresence.id': ompId },
          { omnipresenceInternal: true }
        );
      }

      // Strip world-local / GM-only fields (_id, folder, ownership, author) so
      // the pack copy never carries another world's ids and a non-GM can pull
      // it, then canonicalize links so the pack copy is world-independent.
      const macroData = LinkRewriter.canonicalize(stripMacroLocalFields(macro.toObject()));
      macroData.flags ??= {};
      // originWorld scopes cleanup to the world that pushed the copy (#8).
      macroData.flags.omnipresence = { id: ompId, ownerName: user.name, hotbarSlots: slots, originWorld: game.world.id };

      const existing = compByOmpId.get(ompId);
      if (existing) {
        // recursive:false — the payload is a complete snapshot, so replace
        // subtrees wholesale; merge would resurrect deleted keys forever.
        await existing.update(macroData, { recursive: false });
      } else {
        await Macro.create(macroData, { pack: this.PACK_ID });
      }
      pushedOmpIds.add(ompId);
    }

    // Delete copies of macros no longer on this user's hotbar — except copies
    // a dangling slot still points at (restored on pull), and only copies
    // pushed FROM THIS WORLD: a same-named user in another world owns the
    // rest (#8). Untagged pre-upgrade copies are never deleted here.
    const toDelete = new Set(macroCopiesToDelete(
      userCompDocs.map(d => ({
        omniId: d.getFlag('omnipresence', 'id'),
        ownerName: user.name,
        originWorld: d.getFlag('omnipresence', 'originWorld'),
        slots: d.getFlag('omnipresence', 'hotbarSlots') ?? []
      })),
      { userName: user.name, worldId: game.world.id, pushedIds: [...pushedOmpIds], danglingSlots: [...danglingSlots] }
    ));
    for (const doc of userCompDocs) {
      if (toDelete.has(doc.getFlag('omnipresence', 'id'))) await doc.delete();
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

  /**
   * Cancel (never flush) all pending debounced pushes. Called on page unload
   * so no write can fire into the world-teardown window; the hotbar/macro
   * state is re-derived and pushed at the next GM login.
   */
  static cancelPending() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
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
    // GM: push all users' hotbars to catch up changes made while GM was offline.
    if (game.user.isGM) {
      for (const user of game.users) {
        if (SyncRegistry.isMacroSyncEnabled(user.id)) {
          try {
            await this.pushForUser(user);
          } catch (err) {
            console.error('Omnipresence | macro push failed for user', user.name, err);
          }
        }
      }
    }
    await this.pullOwn();
  }

  /** Pull the current user's own macros and place them on their hotbar. */
  static async pullOwn() {
    const pack = this._getPack();
    if (!pack) return;
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
    const approved = this._approvedHashes();
    const needsConfirm = [];

    for (const compMacro of myDocs) {
      const ompId = compMacro.getFlag('omnipresence', 'id');
      const slots = compMacro.getFlag('omnipresence', 'hotbarSlots') ?? [];

      // Strip world-local / GM-only fields (_id, folder, ownership, author).
      // ownership and author are GM-only in Foundry; leaving them in a non-GM
      // create/update makes the server reject the whole write. On create Foundry
      // assigns the current user as author/owner.
      // …and localize canonical omnipresence ids to this world's ids.
      const macroData = LinkRewriter.localize(stripMacroLocalFields(compMacro.toObject()));
      const localMacro = localById.get(ompId) ?? null;

      // A GM never runs a script macro from another world's pack copy without
      // seeing it first (#5): new here, or changed, and not approved before.
      const decision = decideScriptMacroInstall({
        isGM: game.user.isGM,
        type: macroData.type,
        localType: localMacro?.type,
        localCommand: localMacro ? localMacro.command : null,
        packCommand: macroData.command,
        packHash: this._commandHash(compMacro),
        approvedHashes: approved
      });
      if (decision === 'confirm') {
        needsConfirm.push({ compMacro, macroData, localMacro, slots });
        continue;
      }

      const installed = await this._installPulled(localMacro, macroData, compMacro.name);
      if (!installed) continue;
      for (const slot of slots) newHotbarEntries[slot] = installed.id;
    }

    await this._writeHotbar(newHotbarEntries);

    // Never hold the login reconcile on the GM's answer.
    if (needsConfirm.length) {
      this._confirmScriptMacros(needsConfirm)
        .catch(err => console.error('Omnipresence | script macro confirmation failed', err));
    }
  }

  /** Create or update the local macro from pulled data. Null on failure (logged). */
  static async _installPulled(localMacro, macroData, name) {
    try {
      if (localMacro) {
        await localMacro.update(macroData, { omnipresenceInternal: true, recursive: false });
        return localMacro;
      }
      return await Macro.create(macroData);
    } catch (err) {
      console.error('Omnipresence | macro pull failed for', name, err);
      return null;
    }
  }

  /** Point hotbar slots at local macros: {slot: macroId}. */
  static async _writeHotbar(entries) {
    if (Object.keys(entries).length === 0) return;
    // Write slot by slot and DELETE any empty slot instead of carrying it.
    // Foundry (v14 verified) accepts a null slot on write but then rejects
    // the whole User document at the next load, which removes that user
    // from the join screen. A whole-object write would not clear a null
    // already stored (the update is diffed against the source), so the
    // `-=` deletion key is what actually repairs it.
    const update = {};
    for (const [slot, id] of Object.entries({ ...game.user.hotbar, ...entries })) {
      if (id) update[`hotbar.${slot}`] = id;
      else update[`hotbar.-=${slot}`] = null;
    }
    await game.user.update(update, { omnipresenceInternal: true });
  }

  /**
   * One dialog per login listing every script macro that needs the GM's
   * approval (name, owner, origin world, command). Install installs them all
   * and remembers each command's hash; Skip installs nothing (asked again
   * at the next login).
   */
  static async _confirmScriptMacros(items) {
    const esc = foundry.utils.escapeHTML;
    const L = key => game.i18n.localize(`OMNIPRESENCE.macroConfirm.${key}`);
    const rows = items.map(({ compMacro, macroData }) => {
      const world = compMacro.getFlag('omnipresence', 'originWorld') ?? L('unknownWorld');
      const owner = compMacro.getFlag('omnipresence', 'ownerName') ?? '';
      return `
      <section class="omnipresence-macro-confirm-item">
        <h4>${esc(compMacro.name)}</h4>
        <p class="notes">${esc(game.i18n.format('OMNIPRESENCE.macroConfirm.origin', { owner, world }))}</p>
        <pre><code>${esc(macroData.command ?? '')}</code></pre>
      </section>`;
    }).join('');

    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: L('title') },
      classes: ['omnipresence-macro-confirm'],
      content: `<p>${L('intro')}</p>${rows}`,
      buttons: [
        { action: 'install', label: L('install'), callback: () => 'install' },
        { action: 'skip', label: L('skip'), default: true, callback: () => 'skip' }
      ],
      rejectClose: false
    });
    if (choice !== 'install') return;

    const approved = new Set(this._approvedHashes());
    const entries = {};
    for (const { compMacro, macroData, localMacro, slots } of items) {
      const installed = await this._installPulled(localMacro, macroData, compMacro.name);
      if (!installed) continue;
      approved.add(this._commandHash(compMacro));
      for (const slot of slots) entries[slot] = installed.id;
    }
    await game.settings.set('omnipresence', this.APPROVED_SETTING, [...approved]);
    await this._writeHotbar(entries);
  }
}
