// Pure, Foundry-independent helpers for the 2026-10-11 security fixes
// (hidden packs, shared-copy bindings, macro rules). No game/Hooks/CONST/ui/
// foundry/CONFIG, no node: imports — runs under the Node test runner and in
// the browser.

// ---------------------------------------------------------------------------
// Shared-copy bindings: omniId → the one local document allowed to write it.

/**
 * May this document write (or delete) the shared copy of `binding`'s omni id?
 * @param {{binding: {type: string, id: string}|null|undefined, docType: string, docId: string, copyExists: boolean}} input
 * @returns {'proceed'|'bind'|'refuse'} proceed: bound to this doc; bind: a
 *   genuinely new enrollment (no copy anywhere) — bind, then proceed;
 *   refuse: bound to another doc, or unbound while a copy already exists.
 */
export function decidePushBinding({ binding, docType, docId, copyExists, otherCarrier = false }) {
  if (binding) return binding.type === docType && binding.id === docId ? 'proceed' : 'refuse';
  // Unbound: a second local document carrying the id may be a forgery racing
  // the real owner's first push, so neither binds until a GM settles it.
  return copyExists || otherCarrier ? 'refuse' : 'bind';
}

/**
 * May any pull path (login reconcile, dashboard force-pull, folder force-pull,
 * pin heal) write the shared copy into — or the login push over it — this local
 * document? Once bindings are built only the bound document may: an unbound
 * carrier of an id whose copy exists could be a forgery that got another
 * document bound and copied first (a cross-world first-push race). Before
 * the build, only a binding to a different document refuses.
 * @returns {boolean}
 */
export function pullAllowed({ bindingsBuilt, binding, docId, docType }) {
  if (binding) return binding.type === docType && binding.id === docId;
  return !bindingsBuilt;
}

/**
 * Build bindings from the documents of an existing world. An omni id carried
 * by exactly one document is bound to it; one carried by two or more is left
 * unbound and reported (a pre-upgrade forgery looks exactly like this).
 * @param {Array<{omniId: string, type: string, id: string}>} carriers
 * @returns {{bindings: Object<string, {type: string, id: string}>, duplicates: Object<string, Array<{type: string, id: string}>>}}
 */
export function buildBindings(carriers) {
  const byOmni = new Map();
  for (const c of carriers) {
    if (!c?.omniId) continue;
    if (!byOmni.has(c.omniId)) byOmni.set(c.omniId, []);
    byOmni.get(c.omniId).push({ type: c.type, id: c.id });
  }
  const bindings = {};
  const duplicates = {};
  for (const [omniId, docs] of byOmni) {
    if (docs.length === 1) bindings[omniId] = docs[0];
    else duplicates[omniId] = docs;
  }
  return { bindings, duplicates };
}

/**
 * One-time upgrade only (before `bindingsBuilt`): settle an omni id carried
 * by several Actor/JournalEntry documents whose shared copy exists, so honest
 * duplicates (a Foundry Duplicate of an enrolled document copies its flags)
 * keep syncing. The copy's `ownerName` was stamped by the GM's push from the
 * document's real ownership, which a player cannot forge, so only carriers
 * owned like the copy are candidates (null = GM-owned on both sides). Among
 * them the one whose last sync equals the copy's (the last pusher) wins —
 * the oldest of those when several match, since a Duplicate copies the
 * timestamp too — otherwise the oldest by creation time; ties go to the id.
 * Folder carriers, or no copy, are never resolved here.
 * @param {{carriers: Array<{type: string, id: string, enrolled: boolean, owner: string|null, lastSyncedAt: string|null, createdTime: number|null}>,
 *   copy: {type?: string, ownerName: string|null, syncedAt: string|null}|null}} input
 * @returns {{keep: {type: string, id: string}|null, detach: Array<{type: string, id: string}>}}
 */
export function resolveUpgradeDuplicate({ carriers, copy }) {
  const none = { keep: null, detach: [] };
  const list = carriers ?? [];
  if (!copy || !list.length) return none;
  if (list.some(c => c.type !== 'Actor' && c.type !== 'JournalEntry')) return none;
  const owner = copy.ownerName ?? null;
  const candidates = list.filter(c => (c.owner ?? null) === owner && (!copy.type || c.type === copy.type));
  if (!candidates.length) return none;
  const pushers = copy.syncedAt ? candidates.filter(c => c.lastSyncedAt === copy.syncedAt) : [];
  const pool = pushers.length ? pushers : candidates;
  const created = c => (Number.isFinite(c.createdTime) ? c.createdTime : Infinity);
  const winner = [...pool].sort((a, b) => created(a) - created(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return {
    keep: { type: winner.type, id: winner.id },
    detach: list.filter(c => c !== winner).map(({ type, id }) => ({ type, id }))
  };
}

/**
 * What a refused push records in the duplicates list, or null for nothing.
 * A bound id records nothing (the bound document keeps syncing; the refusal
 * is only logged). An unbound id whose shared copy exists is always recorded
 * with the `SharedCopy` marker — even with no other local carrier — so that
 * removing the other carriers from sync never auto-binds the survivor to a
 * copy another world made. An unbound id with no copy but other carriers is
 * a plain duplicate.
 * @param {{omniId: string, bound: boolean, copyExists: boolean, doc: {type: string, id: string}, others: Array<{type: string, id: string}>}} input
 * @returns {Array<{type: string, id: string}>|null}
 */
export function pushRefusalRecord({ omniId, bound, copyExists, doc, others }) {
  if (bound) return null;
  const docs = [{ type: doc.type, id: doc.id }, ...others.map(({ type, id }) => ({ type, id }))];
  if (copyExists) return [...docs, { type: 'SharedCopy', id: omniId }];
  return others.length ? docs : null;
}

/**
 * Merge newly refused documents into an existing duplicate record. Entries
 * are kept (de-duplicated by type and id), so a `SharedCopy` marker, once
 * recorded, is never dropped by a later refusal of the same id.
 * @param {Array<{type: string, id: string}>|undefined} existing
 * @param {Array<{type: string, id: string}>} docs
 * @returns {Array<{type: string, id: string}>}
 */
export function mergeDuplicateRecord(existing, docs) {
  const out = [];
  const seen = new Set();
  const all = [...(existing ?? []), ...docs];
  // The marker goes last, after every document, wherever it came from.
  for (const d of [...all.filter(d => d.type !== 'SharedCopy'), ...all.filter(d => d.type === 'SharedCopy')]) {
    const key = `${d.type}.${d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: d.type, id: d.id });
  }
  return out;
}

/**
 * Settle recorded duplicates against the documents that exist now. A
 * document removed from sync (unenrolled) no longer counts as a carrier
 * once any carrier is still enrolled.
 * - A record with a `SharedCopy` marker (a carrier refused because a shared
 *   copy already exists; its true owner is unknowable here) is never
 *   auto-bound: it stays listed while an enrolled carrier is left and is
 *   dropped when none is.
 * - Any other record: exactly one enrolled carrier left is bound (the GM
 *   resolved it by removing the others from sync); several stay listed (the
 *   enrolled ones); none enrolled but some still carrying the id stay listed
 *   unbound, so a later re-enroll of one of them settles it the same way;
 *   no carrier at all is dropped.
 * @param {Object<string, Array<{type: string, id: string}>>} duplicates
 * @param {Array<{omniId: string, type: string, id: string, enrolled: boolean}>} carriers
 * @returns {{bind: Object<string, {type: string, id: string}>, remaining: Object<string, Array<{type: string, id: string}>>}}
 */
export function resolveDuplicateBindings(duplicates, carriers) {
  const bind = {};
  const remaining = {};
  const rows = list => list.map(c => ({ type: c.type, id: c.id }));
  for (const omniId of Object.keys(duplicates ?? {})) {
    const live = carriers.filter(c => c.omniId === omniId);
    const enrolled = live.filter(c => c.enrolled);
    if ((duplicates[omniId] ?? []).some(d => d.type === 'SharedCopy')) {
      if (enrolled.length) remaining[omniId] = [...rows(enrolled), { type: 'SharedCopy', id: omniId }];
      continue;
    }
    if (live.length === 0) continue;
    if (enrolled.length === 1) bind[omniId] = { type: enrolled[0].type, id: enrolled[0].id };
    else remaining[omniId] = rows(enrolled.length ? enrolled : live);
  }
  return { bind, remaining };
}

/**
 * omniId → local id for link localizing: only documents a binding points
 * at. An unbound carrier (a forged id, or an unresolved duplicate) never maps.
 * @param {Array<{omniId: string, type: string, id: string}>} docs
 * @param {Object<string, {type: string, id: string}>} bindings
 * @returns {Map<string, string>}
 */
export function boundOmniToLocal(docs, bindings) {
  const map = new Map();
  for (const d of docs) {
    const b = bindings?.[d.omniId];
    if (b && b.type === d.type && b.id === d.id) map.set(d.omniId, d.id);
  }
  return map;
}

/**
 * May a folder delete/remove path drop this pack copy (spec §2)? The local
 * document must be the one bound to the omni id. A copy that is already gone
 * is a silent no-op success. Otherwise the copy must sit in the root's pack
 * tree, and a non-GM actor must own the copy or the root.
 */
export function validateFolderRemoval({ copyExists, copyInTree, bound, copyOwnerName, rootOwnerName, actingUserName, actingIsGM }) {
  if (!bound) return false;
  // Nothing left to delete (Delete All runs the member hook and the root
  // handler; the second finds the copy gone): a silent no-op, so the
  // idempotent tombstone and registry bookkeeping still runs.
  if (!copyExists) return true;
  if (!copyInTree) return false;
  // A GM acting user is exempt from the ownerName rule: GM-owned copies carry
  // no ownerName, and the forged-flag attack comes from non-GM users.
  if (actingIsGM) return true;
  if (!actingUserName) return false;
  return copyOwnerName === actingUserName || rootOwnerName === actingUserName;
}

// ---------------------------------------------------------------------------
// Macro rules.

/**
 * What pushForUser does with one hotbar slot's macro id.
 * @returns {'dangling'|'skip'|'push'} dangling: no such macro here (keep its
 *   copy for the pull to restore); skip: the hotbar's user does not own it
 *   (a GM-only macro must never be published under a player's name, #4); push.
 */
export function macroPushDecision({ exists, ownedByUser }) {
  if (!exists) return 'dangling';
  return ownedByUser ? 'push' : 'skip';
}

/**
 * Whether a pulled macro installs silently or needs the GM's confirmation
 * (#5). Only script macros pulled by a GM are gated, and only when the
 * command is new here (no local copy) or differs from the local copy, and
 * the GM has not already approved that exact command (by hash).
 * @returns {'install'|'confirm'}
 */
export function decideScriptMacroInstall({ isGM, type, localType, localCommand, packCommand, packHash, approvedHashes }) {
  if (!isGM || type !== 'script') return 'install';
  // Only an already-script local macro with the same command is unchanged; a
  // chat macro becoming a script is new code and goes through the hash check.
  if (localType === 'script' && localCommand !== null && localCommand !== undefined && localCommand === packCommand) return 'install';
  if (Array.isArray(approvedHashes) && approvedHashes.includes(packHash)) return 'install';
  return 'confirm';
}

/**
 * Pack copies pushForUser's cleanup may delete (#8): this user's copies
 * pushed from THIS world (originWorld) that were neither pushed now nor are
 * still wanted by a dangling slot. Untagged (pre-upgrade) copies are never
 * deleted: a same-named user in another world may own them.
 * @param {Array<{omniId: string, ownerName: string, originWorld: string|undefined, slots: number[]}>} copies
 * @returns {string[]} omni ids to delete
 */
export function macroCopiesToDelete(copies, { userName, worldId, pushedIds, danglingSlots }) {
  const pushed = new Set(pushedIds ?? []);
  const dangling = new Set(danglingSlots ?? []);
  return copies
    .filter(c => c.ownerName === userName)
    .filter(c => c.originWorld === worldId)
    .filter(c => !pushed.has(c.omniId))
    .filter(c => !(c.slots ?? []).some(s => dangling.has(s)))
    .map(c => c.omniId);
}

// SHA-256 (FIPS 180-4) over the UTF-8 bytes of `text`, as lowercase hex.
// Synchronous and dependency-free: crypto.subtle is missing on a Foundry
// server reached over plain http on a LAN address (not a secure context),
// and a short non-cryptographic hash would let a crafted command collide
// with an approved one.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// Player-written pendingRemove flags.

/**
 * Whether a `pendingRemove` flag on a journal may be acted on. The flag is
 * writable by the journal's owners, so its claimed `userId` proves nothing:
 * a claimed GM is refused (a GM's own retry lives in a GM-only setting), and
 * a claimed non-GM must actually own the journal. Legacy bare-string flags
 * have no author and are refused.
 * @param {{flag: *, user: ({isGM: boolean}|null|undefined), isOwner: boolean}} p
 *   `user` is the resolved claimed user; `isOwner` whether that user owns the journal.
 * @returns {'accept'|'refuse'}
 */
export function judgePendingRemoveClaim({ flag, user, isOwner }) {
  if (!flag || typeof flag !== 'object' || typeof flag.rootId !== 'string') return 'refuse';
  if (!user || user.isGM) return 'refuse';
  return isOwner ? 'accept' : 'refuse';
}

// ---------------------------------------------------------------------------
// Hidden packs (#3).

/** Ownership every Omnipresence pack must have: hidden from players and trusted players in the UI. */
export const HIDDEN_PACK_OWNERSHIP = Object.freeze({ PLAYER: 'NONE', TRUSTED: 'NONE', ASSISTANT: 'OWNER' });

const OWNERSHIP_RANK = { NONE: 0, INHERIT: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };

/**
 * Whether a pack ownership map gives PLAYER or TRUSTED anything above NONE.
 * Unknown or missing levels count as NONE (Foundry ignores them too); a
 * TRUSTED of INHERIT takes PLAYER's level, which is checked on its own.
 */
export function ownershipExposesPlayers(ownership) {
  const rank = level => OWNERSHIP_RANK[level] ?? 0;
  return rank(ownership?.PLAYER) > 0 || rank(ownership?.TRUSTED) > 0;
}
