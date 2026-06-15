# Batch Login Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential per-character conflict modals at login with the existing dashboard, opened filtered to only the conflicting characters, where the user resolves them all in one place.

**Architecture:** `SyncEngine.onLogin()` stops prompting per conflict; it collects conflicting actor ids and, after auto-syncing clean actors, opens `OmnipresenceDashboard` in a new conflicts-only mode. The dashboard gains: a `conflictActorIds` filter, authoritative conflict badges (computed against the compendium), enriched timestamps on conflict rows, per-row force-push/force-pull actions for player rows, and auto-close when the last conflict resolves. The now-unused `ConflictResolver` is deleted.

**Tech Stack:** Foundry VTT v13 module (ES modules), `foundry.applications.api.ApplicationV2` + Handlebars, Node's built-in test runner (`node --test`).

---

## File Structure

- `scripts/sync-logic.js` — add pure `deriveConflictState()` (Foundry-independent, unit-tested).
- `tests/sync-logic.test.js` — tests for `deriveConflictState()`.
- `scripts/gm-dashboard.js` — conflicts-only mode, pack-backed badge, enriched timestamps, auto-close.
- `templates/settings-panel.hbs` — two-timestamp conflict cells; player rows get force-push/force-pull.
- `lang/en.json` — add conflict-view i18n keys; remove dead `OMNIPRESENCE.conflict.*` keys.
- `scripts/sync-engine.js` — collect conflicts + open dashboard; drop the per-actor modal.
- `scripts/conflict-resolver.js` — **deleted**.

---

## Task 1: Pure `deriveConflictState` helper

The dashboard must show an accurate conflict badge. When the compendium is loaded it uses the authoritative `decideSyncAction`; when the pack can't be loaded it falls back to the local-only heuristic (`localModifiedAt > localSyncedAt`). This branching is pure logic, so it lives in `sync-logic.js` and is unit-tested.

**Files:**
- Modify: `scripts/sync-logic.js`
- Test: `tests/sync-logic.test.js`

- [ ] **Step 1: Write the failing tests**

First, extend the existing import at the top of `tests/sync-logic.test.js` to include the new helper. Change:

```javascript
import { decideSyncAction, stripWorldLocalFields, diffEmbedded, resolveOwningActor } from '../scripts/sync-logic.js';
```

to:

```javascript
import { decideSyncAction, stripWorldLocalFields, diffEmbedded, resolveOwningActor, deriveConflictState } from '../scripts/sync-logic.js';
```

Then add these tests to the end of `tests/sync-logic.test.js`:

```javascript
test('deriveConflictState: comp available, both sides changed → true', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T2, localModifiedAt: T1, compAvailable: true }),
    true
  );
});

test('deriveConflictState: comp available, only local changed → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: T1, compAvailable: true }),
    false
  );
});

test('deriveConflictState: comp available, only comp newer → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T2, localModifiedAt: T0, compAvailable: true }),
    false
  );
});

test('deriveConflictState: comp available, nothing changed → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: T0, localModifiedAt: T0, compAvailable: true }),
    false
  );
});

test('deriveConflictState: comp unavailable, local edited since sync → true (fallback)', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: null, localModifiedAt: T1, compAvailable: false }),
    true
  );
});

test('deriveConflictState: comp unavailable, no local change → false (fallback)', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: null, localModifiedAt: T0, compAvailable: false }),
    false
  );
});

test('deriveConflictState: comp unavailable, missing localModifiedAt falls back to syncedAt → false', () => {
  assert.equal(
    deriveConflictState({ localSyncedAt: T0, compSyncedAt: null, localModifiedAt: undefined, compAvailable: false }),
    false
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SyntaxError` / `does not provide an export named 'deriveConflictState'`.

- [ ] **Step 3: Implement `deriveConflictState`**

Add to `scripts/sync-logic.js`, immediately after the `decideSyncAction` function (it reuses `decideSyncAction`):

```javascript
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
  const t = (iso) => (iso ? new Date(iso).getTime() : 0);
  const localSync = t(localSyncedAt);
  const localMod = localModifiedAt ? t(localModifiedAt) : localSync;
  return localMod > localSync;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all existing tests plus the 7 new `deriveConflictState` tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-logic.js tests/sync-logic.test.js
git commit -m "feat: add pure deriveConflictState helper for dashboard badge"
```

---

## Task 2: Add conflict-view i18n keys

Add the strings the conflicts-only dashboard view needs. (Removal of the dead `OMNIPRESENCE.conflict.*` keys happens in Task 7, alongside deleting their only consumer.)

**Files:**
- Modify: `lang/en.json`

- [ ] **Step 1: Add the new keys**

In `lang/en.json`, after the line `"OMNIPRESENCE.dashboard.title": "Omnipresence Sync",` add:

```json
  "OMNIPRESENCE.dashboard.conflictsTitle": "Omnipresence — Resolve Sync Conflicts",
  "OMNIPRESENCE.dashboard.yourLastEdit": "Your last edit",
  "OMNIPRESENCE.dashboard.sharedUpdated": "Shared updated",
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('lang/en.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add lang/en.json
git commit -m "i18n: add conflicts-only dashboard view strings"
```

---

## Task 3: Dashboard conflicts-only mode (filter, constructor, title)

Let the dashboard be opened scoped to a specific set of actor ids, with a distinct window title. Opened normally from settings (no ids) it behaves exactly as today.

**Files:**
- Modify: `scripts/gm-dashboard.js`

- [ ] **Step 1: Capture the conflict id set in a constructor**

In `scripts/gm-dashboard.js`, inside the `OmnipresenceDashboard` class, add a constructor immediately after the `static PARTS = { ... };` block:

```javascript
  constructor(options = {}) {
    super(options);
    // When opened from the login flow this holds the ids of conflicting actors;
    // null when opened normally from settings (full dashboard).
    this.conflictActorIds = options.conflictActorIds ?? null;
  }

  get title() {
    if (this.conflictActorIds) {
      return game.i18n.localize('OMNIPRESENCE.dashboard.conflictsTitle');
    }
    return game.i18n.localize(this.options.window.title);
  }
```

- [ ] **Step 2: Filter visible actors when in conflicts-only mode**

In `_prepareContext`, replace these lines:

```javascript
    const isGM = game.user.isGM;
    const allActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    const visibleActors = isGM ? allActors : allActors.filter(a => a.isOwner);
```

with:

```javascript
    const isGM = game.user.isGM;
    const allActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    let visibleActors = isGM ? allActors : allActors.filter(a => a.isOwner);
    if (this.conflictActorIds) {
      const ids = new Set(this.conflictActorIds);
      visibleActors = visibleActors.filter(a => ids.has(a.id));
    }
```

- [ ] **Step 3: Expose the mode flag to the template**

In `_prepareContext`, change the final return from:

```javascript
    return { isGM, actors };
```

to:

```javascript
    return { isGM, actors, conflictsOnly: !!this.conflictActorIds };
```

- [ ] **Step 4: Verify the file parses**

Run: `node --check scripts/gm-dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add scripts/gm-dashboard.js
git commit -m "feat: add conflicts-only mode to dashboard (filter + title)"
```

---

## Task 4: Pack-backed badge + enriched conflict timestamps

Make the conflict badge authoritative by loading the compendium and using `deriveConflictState`, and surface "Your last edit" / "Shared updated" timestamps so the keep-mine / use-shared choice is informed. In conflicts-only mode, rows that are no longer conflicting drop out (this is what lets Task 6 auto-close).

**Files:**
- Modify: `scripts/gm-dashboard.js`
- Modify: `templates/settings-panel.hbs`

- [ ] **Step 1: Import the pure helper**

In `scripts/gm-dashboard.js`, add to the imports at the top of the file:

```javascript
import { deriveConflictState } from './sync-logic.js';
```

- [ ] **Step 2: Load the compendium and compute rows**

In `_prepareContext`, replace the entire `const actors = visibleActors.map(a => { ... });` block (and the existing `hasConflict` heuristic inside it) with:

```javascript
    // Load shared syncedAt per actor so the conflict badge is authoritative.
    // compById maps omnipresence-id → shared syncedAt; null if the pack is
    // unavailable, in which case deriveConflictState falls back to local-only.
    let compById = null;
    try {
      const pack = game.packs.get(SyncEngine.PACK_ID);
      if (pack) {
        const docs = await pack.getDocuments();
        compById = new Map(
          docs.map(d => [d.getFlag('omnipresence', 'id'), d.getFlag('omnipresence', 'syncedAt') ?? null])
        );
      }
    } catch (err) {
      console.warn('Omnipresence | dashboard pack load failed, using local-only badge', err);
      compById = null;
    }
    const compAvailable = compById !== null;

    const never = game.i18n.localize('OMNIPRESENCE.dashboard.never');
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : never);

    let actors = visibleActors.map(a => {
      const syncedAt = a.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = a.getFlag('omnipresence', 'localModifiedAt') ?? syncedAt;
      const opId = a.getFlag('omnipresence', 'id');
      const compSyncedAt = compById ? (compById.get(opId) ?? null) : null;
      const hasConflict = deriveConflictState({
        localSyncedAt: syncedAt,
        compSyncedAt,
        localModifiedAt,
        compAvailable
      });
      return {
        id: a.id,
        name: a.name,
        ownerName: a.getFlag('omnipresence', 'ownerName') ?? '—',
        syncedAtFormatted: syncedAt ? new Date(syncedAt).toLocaleString() : never,
        localModifiedAtFormatted: fmt(localModifiedAt),
        compSyncedAtFormatted: fmt(compSyncedAt),
        hasConflict
      };
    });

    // In conflicts-only mode, drop rows that are no longer in conflict so that
    // resolving the last one empties the table (Task 6 auto-closes the window).
    if (this.conflictActorIds) {
      actors = actors.filter(r => r.hasConflict);
    }
```

Note: `_prepareContext` is already `async`, and `SyncEngine` is already imported at the top of the file — no new import needed for it.

- [ ] **Step 3: Show both timestamps on conflict rows in the template**

In `templates/settings-panel.hbs`, there are two `Last Synced` cells (GM table and player table). Replace **both** occurrences of:

```handlebars
        <td>{{this.syncedAtFormatted}}</td>
```

with:

```handlebars
        <td>
          {{this.syncedAtFormatted}}
          {{#if this.hasConflict}}
          <div style="font-size:11px;color:var(--color-text-dark-secondary);margin-top:2px">
            <div>{{localize "OMNIPRESENCE.dashboard.yourLastEdit"}}: {{this.localModifiedAtFormatted}}</div>
            <div>{{localize "OMNIPRESENCE.dashboard.sharedUpdated"}}: {{this.compSyncedAtFormatted}}</div>
          </div>
          {{/if}}
        </td>
```

- [ ] **Step 4: Verify the file parses**

Run: `node --check scripts/gm-dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 5: Verify existing unit tests still pass**

Run: `npm test`
Expected: PASS (no regressions; dashboard isn't unit-tested but `sync-logic` tests must stay green).

- [ ] **Step 6: Commit**

```bash
git add scripts/gm-dashboard.js templates/settings-panel.hbs
git commit -m "feat: authoritative conflict badge + enriched timestamps in dashboard"
```

---

## Task 5: Player rows get force-push / force-pull actions

Player rows currently expose only the remove (unlink) button, so a player can't resolve a conflict from the dashboard. Add the same force-push ("keep mine") and force-pull ("use shared") links the GM rows have. The `_onForcePush` / `_onForcePull` handlers already permit non-GM owners, so this is a template-only change.

**Files:**
- Modify: `templates/settings-panel.hbs`

- [ ] **Step 1: Add the action links to the player row**

In `templates/settings-panel.hbs`, inside the `{{else}}` (non-GM) table, replace the player actions cell:

```handlebars
        <td>
          <a data-action="removeSync" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.remove"}}" style="color:#c0392b"><i class="fas fa-unlink"></i></a>
        </td>
```

with:

```handlebars
        <td>
          <a data-action="forcePush" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.forcePush"}}"><i class="fas fa-upload"></i></a>
          <a data-action="forcePull" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.forcePull"}}"><i class="fas fa-download"></i></a>
          <a data-action="removeSync" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.remove"}}" style="color:#c0392b"><i class="fas fa-unlink"></i></a>
        </td>
```

- [ ] **Step 2: Commit**

```bash
git add templates/settings-panel.hbs
git commit -m "feat: expose force-push/force-pull on player dashboard rows"
```

---

## Task 6: Auto-close when the last conflict resolves

In conflicts-only mode, once every conflicting row has been resolved the table is empty (Task 4 filters them out). Close the window automatically on the render that produces an empty table.

**Files:**
- Modify: `scripts/gm-dashboard.js`

- [ ] **Step 1: Add an `_onRender` override**

In `scripts/gm-dashboard.js`, add this method to the `OmnipresenceDashboard` class, immediately after `_prepareContext` (before the `static async _onForcePush` handlers):

```javascript
  /**
   * In conflicts-only mode, close once all conflicts are resolved. Resolving a
   * row re-renders; Task 4 drops resolved rows, so an empty table means done.
   * onLogin only opens this view when at least one conflict exists, so the
   * initial render is never empty.
   */
  _onRender(context, options) {
    super._onRender(context, options);
    if (this.conflictActorIds && context.actors.length === 0) {
      this.close();
    }
  }
```

- [ ] **Step 2: Verify the file parses**

Run: `node --check scripts/gm-dashboard.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

```bash
git add scripts/gm-dashboard.js
git commit -m "feat: auto-close conflicts-only dashboard when all resolved"
```

---

## Task 7: Wire onLogin to the dashboard; delete ConflictResolver

Replace the per-conflict modal loop with conflict collection, then open the dashboard once. Delete the now-unused `ConflictResolver` and its dead i18n keys.

**Files:**
- Modify: `scripts/sync-engine.js`
- Delete: `scripts/conflict-resolver.js`
- Modify: `lang/en.json`

- [ ] **Step 1: Collect conflicts and open the dashboard**

In `scripts/sync-engine.js`, in `onLogin()`, find the actor loop. Just before the loop (`for (const actor of myActors) {`), add:

```javascript
    const conflicts = [];
```

Then replace the conflict branch:

```javascript
      if (action === 'conflict') {
        const { ConflictResolver } = await import('./conflict-resolver.js');
        await ConflictResolver.resolve(actor, compActor, {
          onKeepLocal: () => this.push(actor),
          onUseShared: () => this.pull(actor, compActor)
        });
      } else if (action === 'pull') {
```

with:

```javascript
      if (action === 'conflict') {
        conflicts.push(actor.id);
      } else if (action === 'pull') {
```

(The `else if (action === 'pull')` / `else if (action === 'push')` bodies and the trailing `// 'none': in sync` comment stay unchanged.)

- [ ] **Step 2: Open the dashboard after the loop**

In `scripts/sync-engine.js`, immediately after the actor loop's closing `}` and before the auto-import section line `// 2. Auto-import: compendium actors not present in this world (GM only).`, add:

```javascript
    // Surface any conflicts in one consolidated view instead of N modals.
    // Dynamic import avoids a static cycle (gm-dashboard imports SyncEngine).
    if (conflicts.length > 0) {
      const { OmnipresenceDashboard } = await import('./gm-dashboard.js');
      new OmnipresenceDashboard({ conflictActorIds: conflicts }).render(true);
    }

```

- [ ] **Step 3: Delete the ConflictResolver file**

Run: `git rm scripts/conflict-resolver.js`
Expected: `rm 'scripts/conflict-resolver.js'`.

- [ ] **Step 4: Verify nothing else references ConflictResolver**

Run: `grep -rn "conflict-resolver\|ConflictResolver" scripts/ omnipresence.js tests/`
Expected: no matches (exit code 1, no output).

- [ ] **Step 5: Remove the dead conflict i18n keys**

In `lang/en.json`, delete these five lines:

```json
  "OMNIPRESENCE.conflict.title": "Omnipresence — Sync Conflict",
  "OMNIPRESENCE.conflict.message": "<strong>{name}</strong> has been modified both here and in the shared compendium since your last sync. Which version would you like to keep?",
  "OMNIPRESENCE.conflict.keepLocal": "Keep Local Version",
  "OMNIPRESENCE.conflict.useShared": "Use Shared Version",
  "OMNIPRESENCE.conflict.warning": "The version you don't choose will be permanently overwritten.",
```

- [ ] **Step 6: Verify both files parse and tests pass**

Run: `node --check scripts/sync-engine.js && node -e "JSON.parse(require('fs').readFileSync('lang/en.json','utf8')); console.log('json ok')" && npm test`
Expected: `json ok` then all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/sync-engine.js lang/en.json
git commit -m "feat: open dashboard for batch conflict resolution at login; remove per-actor modal"
```

---

## Task 8: Manual verification in Foundry (v13)

The dashboard and login flow are Foundry-coupled and not unit-testable; verify behavior in a running world.

**Files:** none (manual).

- [ ] **Step 1: Set up conflicting state**

In a world using a supported system, enroll 2–3 actors owned by a single non-GM player. As the GM, edit each enrolled actor (so the shared compendium copy advances). As the player, edit the same actors locally without syncing, so each is in a true conflict (`localModifiedAt` and shared `syncedAt` both newer than local `syncedAt`).

- [ ] **Step 2: Log in as the player**

Expected:
- Clean (non-conflicting) enrolled actors sync silently — no dialog.
- Exactly **one** dashboard window opens, titled "Resolve Sync Conflicts", listing **only** the conflicting actors.
- Each conflict row shows "Your last edit" and "Shared updated" timestamps and a conflict badge.
- Each player row shows force-push (↑), force-pull (↓), and remove links.

- [ ] **Step 3: Resolve conflicts**

Expected:
- Clicking force-push (↑) keeps the local version (pushes); the row leaves the table.
- Clicking force-pull (↓) applies the shared version (pulls); the row leaves the table.
- When the last conflict is resolved, the window closes automatically.

- [ ] **Step 4: Verify dismiss semantics**

Re-create a conflict, log in, and close the dashboard without resolving. Expected: the actor stays in conflict and the dashboard re-appears on the next login (no data lost).

- [ ] **Step 5: Verify the settings dashboard is unchanged**

Open the dashboard from Settings → "Manage Sync" (both as GM and as player). Expected: full actor list (no filtering), full title "Omnipresence Sync", conflict rows now show the accurate badge and the two extra timestamps. GM still sees other users' actors and "Force Sync All".

- [ ] **Step 6: Record results**

Note any deviations. If all steps pass, the feature is complete.
