import { SyncEngine } from './sync-engine.js';
import { MacroSync } from './macro-sync.js';
import { JournalSync } from './journal-sync.js';
import { HIDDEN_PACK_OWNERSHIP, ownershipExposesPlayers } from './security-logic.js';

/**
 * The Omnipresence packs this world loads (the actor pack follows
 * game.system), looked up by id. Never filter them by `visible`: they are
 * hidden from players on purpose, and players still read them through the
 * API to pull their own content.
 */
export function omnipresencePacks() {
  return [SyncEngine.PACK_ID, MacroSync.PACK_ID, JournalSync.PACK_ID]
    .map(id => game.packs.get(id))
    .filter(Boolean);
}

/** GM: module packs load locked; unlock them so pushes can write. */
export async function unlockPacks() {
  for (const pack of omnipresencePacks()) {
    if (pack.locked) await pack.configure({ locked: false });
  }
}

/**
 * GM: a world's GM can open a pack to players in the Compendium sidebar,
 * which puts every world's synced content back in front of players (#3).
 * Re-hide each such pack and say why, once per reset.
 *
 * This only hides the packs in the UI. Foundry does not enforce compendium
 * ownership on reads, so a player using the browser console can still read
 * them (README, "What Omnipresence protects").
 */
export async function hidePacksFromPlayers() {
  const reset = [];
  for (const pack of omnipresencePacks()) {
    if (!ownershipExposesPlayers(pack.ownership)) continue;
    await pack.configure({ ownership: { ...HIDDEN_PACK_OWNERSHIP } });
    reset.push(pack.title);
  }
  if (reset.length) {
    ui.notifications.warn(
      game.i18n.format('OMNIPRESENCE.notifications.packsRehidden', { packs: reset.join(', ') }),
      { permanent: true }
    );
  }
}
