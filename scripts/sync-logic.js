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
