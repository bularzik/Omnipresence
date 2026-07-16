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

// ---------------------------------------------------------------------------
// Cross-world link rewriting (Increment 2).
//
// The shared compendium stores links in a canonical, world-independent form:
// every local document id whose target is enrolled is replaced by the
// target's omnipresence id (`flags.omnipresence.id`, itself a valid
// `randomID(16)` document id — so schema-validated fields like Foundry's
// DocumentUUIDField accept it; an earlier `omni-<id>` prefixed form failed
// that validation and aborted pushes). Localizing reverses that against a
// target world's own ids. Ids absent from the translation map pass through
// untouched, so non-enrolled targets and stable page ids are never rewritten,
// and canonicalize is idempotent (an omniId is never a localToOmni key, and a
// local id is never an omniToLocal key, barring negligible 16-char random
// collisions). Unresolvable canonical ids stay dangling — they look like
// ordinary broken links — until a later login heals them.

const DOC_ID = '[A-Za-z0-9]{16}';
const UUID_BODY = `[A-Za-z]+\\.${DOC_ID}(?:\\.[A-Za-z]+\\.${DOC_ID})*`;

// The leading type segment here is `[A-Za-z]+`, not a document-type
// whitelist, so a whole-string like `Word.<16-alnum>` is rewritten if the id
// half collides with an enrolled local id (accepted: requires a random
// 16-char collision; round-trips cleanly).
/** Whole-string world-local document UUID (Compendium.* is world-independent — excluded). */
export const UUID_PATTERN = new RegExp(`^(?!Compendium\\.)${UUID_BODY}$`);

// In-string link syntaxes. Fresh RegExp per call site is not needed — these are
// only used with String#replace, which resets lastIndex per call.
const AT_UUID_RE = new RegExp(`@UUID\\[((?!Compendium\\.)${UUID_BODY})\\]`, 'g');
const LEGACY_RE = new RegExp(
  `@(Actor|JournalEntry|JournalEntryPage|Scene|Item|Macro|RollTable)\\[(${DOC_ID})\\]`, 'g'
);
const DATA_UUID_RE = new RegExp(`data-uuid="((?!Compendium\\.)${UUID_BODY})"`, 'g');

// Translate the id segments of a dotted uuid ("Type.id.Type.id…"). Segment ids
// the translator does not recognize come back unchanged.
function translateUuid(uuid, translateId) {
  const parts = uuid.split('.');
  for (let i = 1; i < parts.length; i += 2) parts[i] = translateId(parts[i]);
  return parts.join('.');
}

// Rewrite every link occurrence inside one string value.
function rewriteString(value, translateId) {
  if (UUID_PATTERN.test(value)) return translateUuid(value, translateId);
  return value
    .replace(AT_UUID_RE, (_m, uuid) => `@UUID[${translateUuid(uuid, translateId)}]`)
    .replace(LEGACY_RE, (_m, type, id) => `@${type}[${translateId(id)}]`)
    .replace(DATA_UUID_RE, (_m, uuid) => `data-uuid="${translateUuid(uuid, translateId)}"`);
}

// Deep-walk arbitrary plain data, rewriting every string. Pure — returns new
// structures, never mutates the input. `parentKey` lets flag-scope adapters
// hook objects under a `flags` key (see MODULE_ADAPTERS below).
function rewriteDeep(node, translateId, parentKey = null) {
  if (typeof node === 'string') return rewriteString(node, translateId);
  if (Array.isArray(node)) return node.map(n => rewriteDeep(n, translateId, null));
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteDeep(v, translateId, k);
    if (parentKey === 'flags') {
      for (const [scope, adapter] of Object.entries(MODULE_ADAPTERS)) {
        if (out[scope] && typeof out[scope] === 'object') {
          out[scope] = adapter(out[scope], translateId);
        }
      }
    }
    return out;
  }
  return node;
}

// Monk's Enhanced Journal stores relationships keyed by BARE local entry id,
// with a bare `id` property beside a full `uuid` string, and an `actor` flag
// that may be an object with a bare `id`. The generic walk rewrites the uuid
// strings; this adapter keeps the bare ids/keys consistent with them.
function mejAdapter(scope, translateId) {
  const out = { ...scope };
  const rel = out.relationships;
  if (rel && typeof rel === 'object' && !Array.isArray(rel)) {
    const next = {};
    for (const [key, value] of Object.entries(rel)) {
      const newKey = translateId(key);
      // A renamed entry must not clobber an identity-keyed one (and vice versa
      // an identity entry always wins): guards against corrupted pre-fix state
      // where both a stale omni- key and the local key coexist.
      if (newKey !== key && newKey in next) continue;
      const v = (value && typeof value === 'object' && typeof value.id === 'string')
        ? { ...value, id: translateId(value.id) }
        : value;
      next[newKey] = v;
    }
    out.relationships = next;
  }
  if (out.actor && typeof out.actor === 'object' && typeof out.actor.id === 'string') {
    out.actor = { ...out.actor, id: translateId(out.actor.id) };
  }
  return out;
}

// Per-module adapters for link storage the generic walk cannot see (bare local
// ids without a Type. prefix). Each adapter receives the (already deep-walked)
// flag-scope object and the bare-id translator, and returns a new scope object.
const MODULE_ADAPTERS = {
  'monks-enhanced-journal': mejAdapter
};

/**
 * Replace local ids of enrolled documents with the target's canonical
 * omnipresence id throughout `data`. @param localToOmni Map<localId, omniId>
 */
export function canonicalizeLinks(data, localToOmni) {
  const translateId = id => localToOmni.get(id) ?? id;
  return rewriteDeep(data, translateId);
}

/**
 * Replace resolvable canonical omnipresence ids with this world's local ids
 * throughout `data`; unresolvable ids stay dangling (healed at a later login
 * once the target exists). @param omniToLocal Map<omniId, localId>
 */
export function localizeLinks(data, omniToLocal) {
  const translateId = id => omniToLocal.get(id) ?? id;
  return rewriteDeep(data, translateId);
}

// ---------------------------------------------------------------------------
// Map-pin sync (pure helpers). Pins are scene Note documents that travel with
// their enrolled journal: captured into the pack copy's
// flags.omnipresence.pins on push, mirrored onto same-named scenes on apply.

/**
 * Build a journal's cross-world pin payload from per-scene note snapshots.
 * Only notes whose entryId matches journalLocalId are captured; entryId is
 * replaced with the journal's omnipresence id (bare local ids are invisible
 * to the generic link walk, so this substitution is explicit). Scene-name
 * collisions: the first occurrence wins; later same-named scenes that held
 * matching notes are reported for the caller to warn about. Input not mutated.
 * @returns {{ pins: Array<{sceneName: string, note: object}>, duplicateSceneNames: string[] }}
 */
export function capturePinPayload(sceneNotes, journalLocalId, journalOmniId) {
  const seen = new Set();
  const duplicates = new Set();
  const pins = [];
  for (const { sceneName, notes } of sceneNotes ?? []) {
    if (seen.has(sceneName)) {
      if ((notes ?? []).some(n => n.entryId === journalLocalId)) duplicates.add(sceneName);
      continue;
    }
    seen.add(sceneName);
    for (const note of notes ?? []) {
      if (note.entryId !== journalLocalId) continue;
      pins.push({ sceneName, note: { ...structuredClone(note), entryId: journalOmniId } });
    }
  }
  return { pins, duplicateSceneNames: [...duplicates].sort() };
}

/**
 * Localize a pin payload for this world: point every note at the local
 * journal id. (Every pin in a journal's payload targets that journal, so
 * this is a constant substitution.) Input not mutated.
 */
export function localizePins(pins, journalLocalId) {
  return (pins ?? []).map(p => ({
    ...p,
    note: { ...structuredClone(p.note), entryId: journalLocalId }
  }));
}
