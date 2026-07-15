// Pure, Foundry-independent sync helpers.
// No access to game/Hooks/CONST/ui — safe to unit-test under plain Node.

// Shared time conversion: ISO string → epoch ms (null/undefined → 0).
function toEpoch(iso) {
  return iso ? new Date(iso).getTime() : 0;
}

// Whether the actor was edited locally since its last sync. localModifiedAt
// missing → treated as the last-sync time (i.e. no local change).
function localChangedSince(localSyncedAt, localModifiedAt) {
  const localSync = toEpoch(localSyncedAt);
  const localMod = localModifiedAt ? toEpoch(localModifiedAt) : localSync;
  return localMod > localSync;
}

/**
 * Decide what sync action an enrolled actor needs, from timestamps alone.
 * Inputs are ISO date strings or null/undefined.
 * @returns {'push'|'pull'|'conflict'|'none'}
 */
export function decideSyncAction({ localSyncedAt, compSyncedAt, localModifiedAt }) {
  const localSync = toEpoch(localSyncedAt);
  const compSync = toEpoch(compSyncedAt);

  const localChanged = localChangedSince(localSyncedAt, localModifiedAt);
  const compNewer = compSync > localSync;

  if (compNewer && localChanged) return 'conflict';
  if (compNewer) return 'pull';
  if (localChanged) return 'push';
  return 'none';
}

/**
 * Decide whether an enrolled actor is in a sync conflict, for dashboard display.
 * When the shared compendium is loaded (`compAvailable`), uses the authoritative
 * three-timestamp decision. When it could not be loaded, falls back to the
 * local-only heuristic (local edited since last sync).
 * @returns {boolean}
 */
export function deriveConflictState({ localSyncedAt, compSyncedAt, localModifiedAt, compAvailable }) {
  if (compAvailable) {
    return decideSyncAction({ localSyncedAt, compSyncedAt, localModifiedAt }) === 'conflict';
  }
  return localChangedSince(localSyncedAt, localModifiedAt);
}

// Foundry-independent deep equality for plain data objects (no node: imports —
// this file also runs in the browser).
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
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

/**
 * Walk a document's parent chain to the nearest ancestor whose documentName
 * matches. Uses `documentName` (a data property) so it stays Foundry-independent
 * and unit-testable. The passed document itself is never considered (start at
 * parent). Returns the matching ancestor, or null.
 */
export function resolveOwningDocument(doc, documentName) {
  let node = doc?.parent ?? null;
  while (node) {
    if (node.documentName === documentName) return node;
    node = node.parent ?? null;
  }
  return null;
}

/** Walk an embedded document's parent chain to the owning Actor (or null). */
export function resolveOwningActor(doc) {
  return resolveOwningDocument(doc, 'Actor');
}

/** Walk a journal page's parent chain to the owning JournalEntry (or null). */
export function resolveOwningJournal(doc) {
  return resolveOwningDocument(doc, 'JournalEntry');
}

/**
 * Decide whether a document is enrolled, from its stable id, its
 * `flags.omnipresence.enrolled` value, and whether the world registry lists it.
 *
 * The `enrolled` flag is owner-writable (so non-GM owners can enroll without the
 * GM-only world-setting write) and is authoritative when set. When the flag is
 * absent (legacy documents enrolled before flag-based enrollment) the world
 * registry decides, so existing enrollments keep working with no migration.
 * Foundry-independent.
 */
export function isEnrolledFrom({ id, enrolledFlag, inRegistry }) {
  if (!id) return false;
  if (enrolledFlag === true) return true;
  if (enrolledFlag === false) return false;
  return !!inRegistry;
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

// Macros carry an `author` (creating user id) on top of the world-local keys.
// Both `ownership` and `author` are GM-only in Foundry, so a non-GM update that
// includes them is rejected by the server; and both are meaningless in another
// world. Strip all of them before a macro crosses worlds (push or pull).
const MACRO_LOCAL_KEYS = ['_id', 'ownership', 'folder', 'author'];

/**
 * Return a deep clone of macro data with world-local / GM-only fields removed
 * (_id, ownership, folder, author). On create Foundry assigns author and
 * ownership to the acting user, so dropping them lets a non-GM pull succeed.
 * Input is not mutated.
 */
export function stripMacroLocalFields(macroData) {
  const clone = structuredClone(macroData);
  for (const key of MACRO_LOCAL_KEYS) delete clone[key];
  return clone;
}

// Flag scopes that are never a third-party module dependency.
const NON_MODULE_FLAG_SCOPES = new Set(['core', 'omnipresence']);

/**
 * Module ids a journal depends on for full fidelity, derived from
 * (1) page `type` values namespaced as `module.subtype` (prefix before the
 * first dot) and (2) non-core, non-omnipresence `flags` scopes on the entry and
 * every page. Input is a plain object from JournalEntry#toObject(). Returns a
 * sorted, de-duplicated array. Foundry-independent.
 */
export function requiredModulesForJournal(journalData) {
  const ids = new Set();

  const collectFlagScopes = (flags) => {
    for (const scope of Object.keys(flags ?? {})) {
      if (!NON_MODULE_FLAG_SCOPES.has(scope)) ids.add(scope);
    }
  };

  collectFlagScopes(journalData?.flags);
  for (const page of journalData?.pages ?? []) {
    if (typeof page?.type === 'string' && page.type.includes('.')) {
      ids.add(page.type.slice(0, page.type.indexOf('.')));
    }
    collectFlagScopes(page?.flags);
  }

  return [...ids].sort();
}

/**
 * Page media `src` paths that are world-local (begin with `worlds/`) and so may
 * not resolve in another world. Input is a plain object from
 * JournalEntry#toObject(). Foundry-independent.
 */
export function worldLocalMediaPaths(journalData) {
  const paths = [];
  for (const page of journalData?.pages ?? []) {
    if (typeof page?.src === 'string' && page.src.startsWith('worlds/')) {
      paths.push(page.src);
    }
  }
  return paths;
}
