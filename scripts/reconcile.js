import { SyncEngine } from './sync-engine.js';
import { MacroSync } from './macro-sync.js';
import { JournalSync } from './journal-sync.js';
import { OmnipresenceDashboard } from './gm-dashboard.js';

// Tracks an in-flight runLoginReconcile() call, if any. The ready hook and
// the User Config "Manage synced documents…" save handler can both call
// runLoginReconcile(), and `ready` does not block UI interaction — so a
// second call can arrive while the ready-hook run is still awaiting. Two
// concurrent runs would each see the same not-yet-local compendium document
// and both Actor.create/JournalEntry.create it (the GM auto-import has no
// in-flight dedupe), and both could call `new OmnipresenceDashboard(...)
// .render(true)`, which must never happen twice since both instances share
// the static id 'omnipresence-dashboard'. Holding the shared promise here
// makes a second call join the first run instead of starting its own.
let inFlight = null;

/**
 * Run the full login reconcile: actors, macros, journals, then surface any
 * actor AND journal conflicts together in ONE conflicts-only dashboard (both
 * share the static id 'omnipresence-dashboard', so a single instance must
 * carry both lists).
 *
 * Called by the ready hook, and again when the user adds documents in the
 * Manage Synced Documents dialog — without that, a newly checked document
 * would not appear until the next login, which reads as broken.
 *
 * Non-reentrant: if a run is already in flight, callers get that same
 * promise instead of starting a second, concurrent run.
 */
export async function runLoginReconcile() {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const actorConflicts = await SyncEngine.onLogin();
    await MacroSync.onLogin();
    const journalConflicts = await JournalSync.onLogin();

    if ((actorConflicts?.length ?? 0) > 0 || (journalConflicts?.length ?? 0) > 0) {
      new OmnipresenceDashboard({
        conflictActorIds: actorConflicts?.length ? actorConflicts : null,
        conflictJournalIds: journalConflicts?.length ? journalConflicts : null
      }).render(true);
    }
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}
