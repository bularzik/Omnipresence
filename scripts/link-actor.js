import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { FolderSync } from './folder-sync.js';
import { keepLocalLinkFlags } from './sync-logic.js';

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
 * If the local actor was already synced under another id (a DDB re-import the
 * player had added to sync, which pushed a second shared copy Y), this is a
 * MERGE: the owner's selection swaps Y for the chosen id, and shared copy Y
 * becomes a redirect stub so other worlds follow it instead of re-pushing it.
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

  const previousId = SyncRegistry.isEnrolled(localActor) ? localActor.getFlag('omnipresence', 'id') : null;
  if (previousId === omniId) return; // already linked to this character

  await removeStaleCopies(localActor, omniId);

  // Merge: retire Y BEFORE re-keying. Once this actor carries the new id, Y
  // looks "selected but missing" to any live import already in flight, which
  // would re-import it as a duplicate — so drop it from the selection and make
  // its shared copy a stub first.
  if (previousId) {
    const gateUser = SyncRegistry.gateUser(ownerName);
    if (gateUser && (gateUser.id === game.user.id || game.user.isGM)) {
      await SyncRegistry.removeFromSelection(gateUser.id, 'actor', previousId);
    }
    await writeMergeStub(previousId, omniId);
  }

  if (winner === 'shared') {
    await SyncEngine.pull(localActor, compActor, { keepForeignFlags: true });
    await SyncRegistry.enroll(localActor);
  } else {
    const flags = keepLocalLinkFlags({ omniId, ownerName, compSyncedAt, now: new Date().toISOString() });
    if (game.user.isGM) {
      await localActor.update({ 'flags.omnipresence': flags }, { omnipresenceInternal: true });
      await SyncRegistry.enroll(localActor);
      await SyncEngine.push(localActor);
    } else {
      // Players cannot write the pack. Deliberately NOT omnipresenceInternal:
      // the connected GM's updateActor hook sees an enrolled actor change and
      // debounces the push. With no GM online, the GM's next login reconcile
      // pushes it (keepLocalLinkFlags makes decideSyncAction say `push`).
      await localActor.update({ 'flags.omnipresence': flags });
      await SyncRegistry.enroll(localActor);
    }
  }

  ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.linked', { name: localActor.name }));
}

/**
 * Turn shared copy `fromId` into a redirect stub pointing at `toId`: same
 * entry, no data (items/effects emptied), `flags.omnipresence.mergedInto`.
 * Kept rather than deleted so a world still holding `fromId` follows the
 * redirect at login instead of pushing its copy back. Players cannot write
 * the pack: they queue the request for a GM (drainPendingMerges).
 */
export async function writeMergeStub(fromId, toId) {
  if (!game.user.isGM) {
    await SyncRegistry.addPendingMerge(game.user.id, { from: fromId, to: toId });
    return;
  }
  const pack = SyncEngine._getPack();
  if (!pack) return;
  const doc = (await pack.getDocuments()).find(d => d.getFlag('omnipresence', 'id') === fromId);
  if (!doc) return;
  await doc.update({
    name: doc.name,
    items: [],
    effects: [],
    flags: {
      omnipresence: {
        id: fromId,
        mergedInto: toId,
        ownerName: doc.getFlag('omnipresence', 'ownerName') ?? null,
        syncedAt: new Date().toISOString()
      }
    }
  }, { omnipresenceInternal: true, recursive: false });
}

let draining = null;

/**
 * Responsible GM only: write every user's queued merge stubs, then clear
 * them. Non-reentrant (the ready hook and the updateUser hook can overlap).
 */
export async function drainPendingMerges() {
  if (!FolderSync._isResponsibleGM()) return;
  if (draining) return draining;
  draining = (async () => {
    for (const user of game.users) {
      const entries = SyncRegistry.getPendingMerges(user.id);
      if (!entries.length) continue;
      for (const { from, to } of entries) {
        try {
          await writeMergeStub(from, to);
        } catch (err) {
          console.error('Omnipresence | merge stub write failed', from, '→', to, err);
        }
      }
      await SyncRegistry.clearPendingMerges(user.id);
    }
  })();
  try { await draining; } finally { draining = null; }
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
