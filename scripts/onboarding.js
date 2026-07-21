import { SyncRegistry } from './sync-registry.js';
import { DocPicker } from './doc-picker.js';
import { decideOnboarding } from './sync-logic.js';

export class Onboarding {
  /**
   * Ensure the current user has consented before any sync runs in this world.
   * @returns {Promise<boolean>} true → safe to run onLogin; false → dismissed,
   *   hold sync this session and re-ask next login.
   */
  static async ensureOnboarded() {
    const userId = game.user.id;

    try {
      const decision = decideOnboarding({
        hasOnboardedFlag: SyncRegistry.isOnboarded(userId),
        hasPrefs: this._hasStoredPrefs(userId),
        ownsSyncedDoc: this._ownsSyncedDoc()
      });

      if (decision === 'skip') {
        await this._backfill(userId);
        return true;
      }

      const result = await DocPicker.open({ mode: 'onboarding', preselected: null });
      if (!result) return false; // dismissed → leave unonboarded, re-ask
      await this._applyResult(userId, result);
      return true;
    } catch (err) {
      // Never hard-block login: on any failure, leave the user unonboarded
      // (they are re-prompted next login) and skip sync this session.
      console.error('Omnipresence | onboarding failed', err);
      return false;
    }
  }

  static _hasStoredPrefs(userId) {
    const user = game.users?.get(userId);
    return user?.getFlag('omnipresence', 'prefs') != null;
  }

  static _ownsSyncedDoc() {
    const synced = doc =>
      doc.isOwner &&
      SyncRegistry.isEnrolled(doc) &&
      doc.getFlag('omnipresence', 'syncedAt');
    return game.actors.some(synced) || game.journal.some(synced);
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
