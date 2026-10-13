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
export function decidePushBinding({ binding, docType, docId, copyExists }) {
  if (binding) return binding.type === docType && binding.id === docId ? 'proceed' : 'refuse';
  return copyExists ? 'refuse' : 'bind';
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
 * Settle recorded duplicates against the documents that exist now. An omni
 * id with exactly one enrolled carrier left is bound to it (the GM resolved
 * it by unenrolling the others); one with no carriers left is dropped; the
 * rest stay recorded with their current carriers.
 * @param {Object<string, Array<{type: string, id: string}>>} duplicates
 * @param {Array<{omniId: string, type: string, id: string, enrolled: boolean}>} carriers
 * @returns {{bind: Object<string, {type: string, id: string}>, remaining: Object<string, Array<{type: string, id: string}>>}}
 */
export function resolveDuplicateBindings(duplicates, carriers) {
  const bind = {};
  const remaining = {};
  for (const omniId of Object.keys(duplicates ?? {})) {
    const live = carriers.filter(c => c.omniId === omniId);
    if (live.length === 0) continue;
    const enrolled = live.filter(c => c.enrolled);
    if (enrolled.length === 1) bind[omniId] = { type: enrolled[0].type, id: enrolled[0].id };
    else remaining[omniId] = live.map(c => ({ type: c.type, id: c.id }));
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
