import { SyncRegistry } from './sync-registry.js';
import { DocPicker } from './doc-picker.js';
import { decideOnboarding } from './sync-logic.js';
import { FolderSync } from './folder-sync.js';

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
        try {
          await this._askFolderMode(userId);
        } catch (err) {
          // The folder question never holds up sync: undecided keeps the old rule.
          console.error('Omnipresence | folder mode prompt failed', err);
        }
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

    // Seed only the docs this user gates (ownerName rule), not everything a
    // GM happens to own by role.
    const actorIds = game.actors
      .filter(a => a.isOwner && SyncRegistry.isGateUserFor(a) && SyncRegistry.isEnrolled(a))
      .map(a => a.getFlag('omnipresence', 'id'))
      .filter(Boolean);
    const journalIds = game.journal
      .filter(j => j.isOwner && SyncRegistry.isGateUserFor(j) && SyncRegistry.isEnrolled(j))
      .map(j => j.getFlag('omnipresence', 'id'))
      .filter(Boolean);

    // An absent folder list ("all") stays absent: seeding it with today's
    // roots would exclude every root shared later.
    const existing = SyncRegistry.getSelection(userId);
    const folderIds = existing.folderIds === null
      ? null
      : [...new Set([...existing.folderIds, ...FolderSync._eligibleLocalRootIds(userId)])];
    await SyncRegistry.setSelection(userId, {
      actorIds: [...new Set([...existing.actorIds, ...actorIds])],
      journalIds: [...new Set([...existing.journalIds, ...journalIds])],
      folderIds
    });
    await SyncRegistry.setOnboarded(userId);
  }

  /**
   * Persist the picker result. The selection allow-list is the per-doc gate for
   * actors/journals; the actors/journals category prefs are intentionally left
   * at their default (true) so a doc the user enrolls later still syncs. Only
   * macros (all-or-nothing, no list) is written to prefs here.
   */
  static async _applyResult(userId, { actorIds, journalIds, folderIds, folderMode, macros }) {
    await SyncRegistry.setSelection(userId, folderIds === null ? { actorIds, journalIds } : { actorIds, journalIds, folderIds });
    await SyncRegistry.setPrefs(userId, { macros });
    await FolderSync.setFolderMode(userId, folderMode ?? 'all');
    await SyncRegistry.setOnboarded(userId);
  }

  /**
   * Users onboarded before folder modes existed choose once. Dismissing
   * changes nothing and asks again next login; sync runs either way.
   */
  static async _askFolderMode(userId) {
    if (SyncRegistry.getPrefs(userId).folders !== null) return;
    const L = key => game.i18n.localize(`OMNIPRESENCE.folderMode.${key}`);
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: L('title') },
      classes: ['omnipresence-folder-mode-prompt'],
      content: `<p>${L('intro')}</p>`,
      buttons: [
        { action: 'all', label: L('all'), default: true, callback: () => 'all' },
        { action: 'chosen', label: L('chosen'), callback: () => 'chosen' }
      ],
      rejectClose: false
    });
    if (choice === 'all' || choice === 'chosen') await FolderSync.setFolderMode(userId, choice);
  }
}
