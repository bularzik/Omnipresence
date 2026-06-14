// Pure, Foundry-independent sync helpers.
// No access to game/Hooks/CONST/ui — safe to unit-test under plain Node.

/**
 * Decide what sync action an enrolled actor needs, from timestamps alone.
 * Inputs are ISO date strings or null/undefined.
 * @returns {'push'|'pull'|'conflict'|'none'}
 */
export function decideSyncAction({ localSyncedAt, compSyncedAt, localModifiedAt }) {
  const t = (iso) => (iso ? new Date(iso).getTime() : 0);
  const localSync = t(localSyncedAt);
  const compSync = t(compSyncedAt);
  const localMod = localModifiedAt ? t(localModifiedAt) : localSync;

  const localChanged = localMod > localSync;
  const compNewer = compSync > localSync;

  if (compNewer && localChanged) return 'conflict';
  if (compNewer) return 'pull';
  if (localChanged) return 'push';
  return 'none';
}

// Foundry-independent deep equality for plain data objects (no node: imports —
// this file also runs in the browser).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Diff two arrays of embedded-document data by `_id`.
 * @returns {{toCreate: object[], toUpdate: object[], toDelete: string[]}}
 *   toCreate/toUpdate are full snapshot objects; toDelete is a list of _ids.
 *   Docs present on both sides with identical data are omitted.
 */
export function diffEmbedded(localDocs, snapshotDocs) {
  const localById = new Map(localDocs.map(d => [d._id, d]));
  const snapById = new Map(snapshotDocs.map(d => [d._id, d]));

  const toDelete = [];
  for (const id of localById.keys()) {
    if (!snapById.has(id)) toDelete.push(id);
  }

  const toCreate = [];
  const toUpdate = [];
  for (const [id, snap] of snapById) {
    const local = localById.get(id);
    if (!local) toCreate.push(snap);
    else if (!deepEqual(local, snap)) toUpdate.push(snap);
  }

  return { toCreate, toUpdate, toDelete };
}

const WORLD_LOCAL_KEYS = ['_id', 'ownership', 'folder'];

/**
 * Return a deep clone of actor data with world-local fields removed
 * (_id, ownership, folder). These reference IDs meaningless in any other
 * world, so they must never cross the shared compendium. Input is not mutated.
 */
export function stripWorldLocalFields(actorData) {
  const clone = structuredClone(actorData);
  for (const key of WORLD_LOCAL_KEYS) delete clone[key];
  return clone;
}
