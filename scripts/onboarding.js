import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { JournalSync } from './journal-sync.js';
import { decideOnboarding } from './sync-logic.js';

export class Onboarding {
  /**
   * Ensure the current user has consented before any sync runs in this world.
   * @returns {Promise<boolean>} true → safe to run onLogin; false → dismissed,
   *   hold sync this session and re-ask next login.
   */
  static async ensureOnboarded() {
    const userId = game.user.id;

    const decision = decideOnboarding({
      hasOnboardedFlag: SyncRegistry.isOnboarded(userId),
      hasPrefs: this._hasStoredPrefs(userId),
      ownsSyncedActor: this._ownsSyncedActor()
    });

    if (decision === 'skip') {
      await this._backfill(userId);
      return true;
    }

    try {
      const candidates = await this._buildCandidates();
      const result = await this._prompt(candidates);
      if (!result) return false; // dismissed → leave unonboarded, re-ask
      await this._applyResult(userId, result);
      return true;
    } catch (err) {
      // Never hard-block login: on failure, leave the user unonboarded (they
      // are re-prompted next login) and skip sync this session.
      console.error('Omnipresence | onboarding prompt failed', err);
      return false;
    }
  }

  static _hasStoredPrefs(userId) {
    const user = game.users?.get(userId);
    return user?.getFlag('omnipresence', 'prefs') != null;
  }

  static _ownsSyncedActor() {
    return game.actors.some(a =>
      a.isOwner &&
      SyncRegistry.isEnrolled(a) &&
      a.getFlag('omnipresence', 'syncedAt')
    );
  }

  /**
   * Existing world: seed the allow-list with every enrolled doc this user
   * already owns, so the new allow-list filter does not suddenly exclude
   * docs that were syncing before this feature shipped. Then mark onboarded.
   */
  static async _backfill(userId) {
    if (SyncRegistry.isOnboarded(userId)) return;

    const actorIds = game.actors
      .filter(a => a.isOwner && SyncRegistry.isEnrolled(a))
      .map(a => a.getFlag('omnipresence', 'id'))
      .filter(Boolean);
    const journalIds = game.journal
      .filter(j => j.isOwner && SyncRegistry.isEnrolled(j))
      .map(j => j.getFlag('omnipresence', 'id'))
      .filter(Boolean);

    const existing = SyncRegistry.getSelection(userId);
    await SyncRegistry.setSelection(userId, {
      actorIds: [...new Set([...existing.actorIds, ...actorIds])],
      journalIds: [...new Set([...existing.journalIds, ...journalIds])]
    });
    await SyncRegistry.setOnboarded(userId);
  }

  static async _buildCandidates() {
    const actors = await this._candidatesFor(SyncEngine.PACK_ID, game.actors);
    const journals = await this._candidatesFor(JournalSync.PACK_ID, game.journal);
    return { actors, journals };
  }

  /**
   * Named candidate docs for the picker: the user's enrolled docs already in
   * this world plus their enrolled docs in the shared pack (matched by
   * ownerName), deduped by omnipresence id, sorted by name.
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  static async _candidatesFor(packId, worldCollection) {
    const byId = new Map();

    for (const doc of worldCollection) {
      if (!doc.isOwner) continue;
      if (!SyncRegistry.isEnrolled(doc)) continue;
      const id = doc.getFlag('omnipresence', 'id');
      if (id) byId.set(id, doc.name);
    }

    const pack = game.packs.get(packId);
    if (pack) {
      const docs = await pack.getDocuments();
      for (const doc of docs) {
        const id = doc.getFlag('omnipresence', 'id');
        if (!id) continue;
        if (doc.getFlag('omnipresence', 'ownerName') !== game.user.name) continue;
        if (!byId.has(id)) byId.set(id, doc.name);
      }
    }

    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  static _renderContent({ actors, journals }) {
    const esc = foundry.utils.escapeHTML;
    const L = key => game.i18n.localize(`OMNIPRESENCE.onboarding.${key}`);

    const list = (items, kind, noneKey) => {
      if (!items.length) return `<p class="notes">${L(noneKey)}</p>`;
      return items.map(({ id, name }) => `
        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" data-kind="${kind}" value="${esc(id)}" checked>
            ${esc(name)}
          </label>
        </div>`).join('');
    };

    return `
      <p>${L('intro')}</p>
      <fieldset>
        <legend>${L('actorsHeading')}</legend>
        ${list(actors, 'actor', 'noneActors')}
      </fieldset>
      <fieldset>
        <legend>${L('journalsHeading')}</legend>
        ${list(journals, 'journal', 'noneJournals')}
      </fieldset>
      <fieldset>
        <legend>${L('macrosHeading')}</legend>
        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="omnipresence-macros" checked>
            ${L('macrosLabel')}
          </label>
        </div>
      </fieldset>
    `;
  }

  /**
   * @returns {Promise<{actorIds: string[], journalIds: string[], macros: boolean}|null>}
   *   null when the user dismissed the dialog without confirming.
   */
  static async _prompt(candidates) {
    const { DialogV2 } = foundry.applications.api;
    const result = await DialogV2.wait({
      window: { title: game.i18n.localize('OMNIPRESENCE.onboarding.title') },
      content: this._renderContent(candidates),
      buttons: [
        {
          action: 'confirm',
          label: game.i18n.localize('OMNIPRESENCE.onboarding.confirm'),
          default: true,
          callback: (event, button) => this._collect(button.form)
        }
      ],
      rejectClose: false
    });
    return result ?? null;
  }

  static _collect(form) {
    const checked = sel =>
      [...form.querySelectorAll(sel)].map(i => i.value);
    return {
      actorIds: checked('input[data-kind="actor"]:checked'),
      journalIds: checked('input[data-kind="journal"]:checked'),
      macros: form.querySelector('input[name="omnipresence-macros"]').checked
    };
  }

  /**
   * Persist the picker result. The selection allow-list is the per-doc gate for
   * actors/journals; the actors/journals category prefs are intentionally left
   * at their default (true) so a doc the user enrolls later still syncs. Only
   * macros (all-or-nothing, no list) is written to prefs here.
   */
  static async _applyResult(userId, { actorIds, journalIds, macros }) {
    await SyncRegistry.setSelection(userId, { actorIds, journalIds });
    await SyncRegistry.setPrefs(userId, { macros });
    await SyncRegistry.setOnboarded(userId);
  }
}
