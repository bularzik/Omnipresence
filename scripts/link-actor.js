import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { LinkRewriter } from './link-rewriter.js';
import { stripWorldLocalFields, mergeForeignFlags, keepLocalLinkFlags } from './sync-logic.js';

/**
 * Link a local actor to a shared compendium character so they sync as one
 * (op-87b). The typical case is a D&D Beyond re-import that never got the
 * compendium copy's omnipresence id.
 *
 * - `'shared'` ("Use this"): the compendium copy replaces the local actor's
 *   data, but the local actor keeps its other modules' flags (e.g.
 *   `ddbimporter`), so "update from D&D Beyond" keeps working here.
 * - `'local'` ("Keep this"): the local actor wins and is pushed over the
 *   shared copy (by this GM, or by a connected GM for a player).
 *
 * A different local actor already carrying the compendium id (an earlier
 * auto-import) is removed first, so the world never holds two copies.
 *
 * @param {Actor} localActor
 * @param {Actor} compActor the pack document
 * @param {'local'|'shared'} winner
 */
export async function linkActor(localActor, compActor, winner) {
  const compData = compActor.toObject();
  const omniId = compData.flags?.omnipresence?.id;
  if (!omniId) throw new Error('Omnipresence | linkActor: compendium actor has no omnipresence id');
  const ownerName = compData.flags.omnipresence.ownerName ?? null;
  const compSyncedAt = compData.flags.omnipresence.syncedAt;

  await removeStaleCopies(localActor, omniId);

  if (winner === 'shared') {
    const data = LinkRewriter.localize(stripWorldLocalFields(compData));
    data.flags = mergeForeignFlags(localActor.toObject().flags, data.flags);
    data.flags.omnipresence = { ...data.flags.omnipresence, enrolled: true };
    // No local changes outstanding after taking the shared copy.
    data.flags.omnipresence.localModifiedAt = data.flags.omnipresence.syncedAt;
    // recursive:false — a complete snapshot (items/effects included), as in pull.
    await localActor.update(data, { omnipresenceInternal: true, recursive: false });
    await SyncRegistry.enroll(localActor);
  } else {
    const flags = keepLocalLinkFlags({ omniId, ownerName, compSyncedAt, now: new Date().toISOString() });
    await localActor.update({ 'flags.omnipresence': flags }, { omnipresenceInternal: true });
    await SyncRegistry.enroll(localActor);
    if (game.user.isGM) await SyncEngine.push(localActor);
  }

  ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.linked', { name: localActor.name }));
}

/**
 * Remove every OTHER local actor carrying `omniId`. Players usually lack
 * permission to delete actors; such a copy is detached from sync instead
 * (left as an ordinary actor for the GM to clean up), which is enough to
 * keep one synced copy per id.
 */
async function removeStaleCopies(localActor, omniId) {
  const stale = game.actors.filter(a => a.id !== localActor.id && a.getFlag('omnipresence', 'id') === omniId);
  for (const actor of stale) {
    if (actor.canUserModify(game.user, 'delete')) {
      await actor.delete({ omnipresenceInternal: true });
    } else {
      await actor.update(
        { 'flags.omnipresence.id': null, 'flags.omnipresence.enrolled': false },
        { omnipresenceInternal: true }
      );
      ui.notifications.warn(game.i18n.format('OMNIPRESENCE.notifications.staleCopyDetached', { name: actor.name }));
    }
  }
}
