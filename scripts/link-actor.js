import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { Bindings } from './bindings.js';
import { FolderSync } from './folder-sync.js';
import { keepLocalLinkFlags, isValidMergeRequest } from './sync-logic.js';

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
 * @returns {Promise<boolean>} false when the shared data could not be taken
 */
export async function linkActor(localActor, compActor, winner) {
  const compData = compActor.toObject();
  const omniId = compData.flags?.omnipresence?.id;
  if (!omniId) throw new Error('Omnipresence | linkActor: compendium actor has no omnipresence id');
  const ownerName = compData.flags.omnipresence.ownerName ?? null;
  const compSyncedAt = compData.flags.omnipresence.syncedAt;

  // Only a GM, or the player the shared copy belongs to, may take it (the
  // dialog lists nothing else); the pull below skips the binding check on
  // that basis.
  if (!game.user.isGM && !SyncRegistry.isGateUserFor(compActor)) return false;

  const previousId = SyncRegistry.isEnrolled(localActor) ? localActor.getFlag('omnipresence', 'id') : null;
  if (previousId === omniId) return true; // already linked to this character

  await removeStaleCopies(localActor, omniId);

  // A GM linking on a player's behalf: the actor becomes that player's here.
  // Every push re-stamps ownerName from local ownership, so without this a
  // GM-owned actor would turn the player's shared character into the GM's.
  const owner = ownerName ? SyncRegistry.gateUser(ownerName) : null;
  if (game.user.isGM && owner && localActor.ownership?.[owner.id] !== CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
    await localActor.update({ [`ownership.${owner.id}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }, { omnipresenceInternal: true });
  }

  // Merge: retire Y BEFORE re-keying. Once this actor carries the new id, Y
  // looks "selected but missing" to any live import already in flight, which
  // would re-import it as a duplicate — so drop it from the selection and make
  // its shared copy a stub first.
  if (previousId) {
    // Y sits on ITS owner's list, which differs from X's when a GM merges a
    // player's copy into a character someone else owns.
    const gateUser = SyncRegistry.gateUser(localActor.getFlag('omnipresence', 'ownerName') ?? null);
    if (gateUser && (gateUser.id === game.user.id || game.user.isGM)) {
      await SyncRegistry.removeFromSelection(gateUser.id, 'actor', previousId);
    }
    await writeMergeStub(previousId, omniId);
  }

  if (winner === 'shared') {
    // A failed pull already warned; enrolling would sync the actor's old data
    // as this character.
    if (!await SyncEngine.pull(localActor, compActor, { keepForeignFlags: true, authorized: true })) return false;
    await SyncRegistry.enroll(localActor);
    // A GM binds the re-keyed actor now; a player's is bound by the active GM
    // (Bindings.adopt) once it sees the new id and the player's list.
    if (game.user.isGM) await Bindings.bind(localActor);
  } else {
    const flags = keepLocalLinkFlags({ omniId, ownerName, compSyncedAt, now: new Date().toISOString() });
    if (game.user.isGM) {
      await localActor.update({ 'flags.omnipresence': flags }, { omnipresenceInternal: true });
      await SyncRegistry.enroll(localActor);
      await Bindings.bind(localActor);
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
  return true;
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
let drainAgain = false;

/**
 * Responsible GM only: write every user's queued merge stubs, then remove
 * them from the queue. The queue sits on the player's own User flags, so every
 * entry is authorized first (isValidMergeRequest: only the requester's own
 * copies); anything else is dropped and logged, never written. Calls that
 * arrive mid-drain (the ready hook and the updateUser hook overlap, and a
 * player may queue again while a stub is written) run one more pass, and only
 * the entries a pass handled are removed, so a request queued meanwhile stays.
 */
export async function drainPendingMerges() {
  if (!FolderSync._isResponsibleGM()) return;
  if (draining) { drainAgain = true; return draining; }
  draining = (async () => {
    try {
      do { drainAgain = false; await drainOnce(); } while (drainAgain);
    } finally { draining = null; }
  })();
  return draining;
}

async function drainOnce() {
  const pack = SyncEngine._getPack();
  if (!pack) return;
  let packIndex = null;
  for (const user of game.users) {
    const entries = SyncRegistry.getPendingMerges(user.id);
    if (!entries.length) continue;
    packIndex ??= Object.fromEntries((await pack.getDocuments()).map(d => [
      d.getFlag('omnipresence', 'id'),
      { ownerName: d.getFlag('omnipresence', 'ownerName') ?? null, mergedInto: d.getFlag('omnipresence', 'mergedInto') ?? null }
    ]));
    for (const entry of entries) {
      if (!isValidMergeRequest(entry, user.name, packIndex)) {
        console.warn('Omnipresence | rejected merge request from', user.name, entry);
        continue;
      }
      try {
        await writeMergeStub(entry.from, entry.to);
        packIndex[entry.from] = { ...packIndex[entry.from], mergedInto: entry.to };
      } catch (err) {
        console.error('Omnipresence | merge stub write failed', entry.from, '→', entry.to, err);
      }
    }
    // Re-read: entries queued while this pass ran are kept for the next one.
    const handled = new Set(entries.map(e => JSON.stringify(e)));
    await SyncRegistry.setPendingMerges(user.id,
      SyncRegistry.getPendingMerges(user.id).filter(e => !handled.has(JSON.stringify(e))));
  }
}

/** Edited here since its last sync (localModifiedAt newer than syncedAt). */
export function hasUnpushedChanges(actor) {
  return Date.parse(actor.getFlag('omnipresence', 'localModifiedAt') ?? 0) >
         Date.parse(actor.getFlag('omnipresence', 'syncedAt') ?? 0);
}

/**
 * Remove every OTHER local actor carrying `omniId`. One with unpushed changes
 * is never deleted: it is detached from sync instead, keeping those edits. Players usually lack
 * permission to delete actors; such a copy is detached from sync instead
 * (left as an ordinary actor for the GM to clean up), which is enough to
 * keep one synced copy per id.
 */
async function removeStaleCopies(localActor, omniId) {
  const stale = game.actors.filter(a => a.id !== localActor.id && a.getFlag('omnipresence', 'id') === omniId);
  for (const actor of stale) {
    if (!hasUnpushedChanges(actor) && actor.canUserModify(game.user, 'delete')) {
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
