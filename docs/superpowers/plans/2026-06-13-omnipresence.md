# Omnipresence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Foundry VTT v13+ module that synchronizes player character actors across multiple worlds on the same server via a shared module compendium pack.

**Architecture:** A module compendium pack (`omnipresence.omnipresence-actors`) serves as the single source of truth. Five ES modules handle registry, push/pull, conflict resolution, the settings dashboard, and context menu wiring. The entry point (`omnipresence.js`) registers all Foundry hooks and delegates to these modules. Conflict detection uses two actor flags: `syncedAt` (timestamp of last successful sync) and `localModifiedAt` (timestamp of last user-initiated edit), allowing silent pulls when only the compendium changed vs. prompting when both sides changed.

**Tech Stack:** Foundry VTT v13+ JavaScript API (ES modules), Handlebars templates, LevelDB compendium pack, `ApplicationV2` + `HandlebarsApplicationMixin` for UI, `DialogV2` for conflict prompts.

---

## File Map

| File | Responsibility |
|---|---|
| `module.json` | Module manifest, pack declaration, compatibility |
| `omnipresence.js` | Entry point — registers hooks only, no logic |
| `scripts/sync-registry.js` | World-scoped setting tracking enrolled actor UUIDs |
| `scripts/sync-engine.js` | Push/pull to compendium, debounce, login sync, auto-import |
| `scripts/conflict-resolver.js` | `DialogV2`-based prompt when both sides changed |
| `scripts/context-menu.js` | `getActorDirectoryEntryContext` hook handler |
| `scripts/gm-dashboard.js` | `ApplicationV2` settings panel (GM + player views) |
| `templates/settings-panel.hbs` | Handlebars template for the dashboard |
| `packs/omnipresence-actors/` | Empty directory — Foundry creates LevelDB files here |
| `lang/en.json` | All user-facing strings |
| `styles/omnipresence.css` | Minimal dashboard styles |

### Actor flags written by this module

| Flag | Set when | Meaning |
|---|---|---|
| `flags.omnipresence.id` | Enrollment | Stable UUID, used to match actors across worlds |
| `flags.omnipresence.ownerName` | Enrollment | User name of the non-GM owner — used for cross-world auto-import |
| `flags.omnipresence.syncedAt` | Push/pull | ISO timestamp of last successful sync |
| `flags.omnipresence.localModifiedAt` | Every user edit | ISO timestamp of last user-initiated change — drives conflict detection |

`localModifiedAt` is stripped from data before writing to the compendium (it is world-local metadata). After a pull, it is reset to the compendium's `syncedAt`.

Internal updates (flag writes by the module itself) pass `{ omnipresenceInternal: true }` in options so the `updateActor` hook skips them.

---

## Task 1: Module Scaffold

**Files:**
- Create: `module.json`
- Create: `omnipresence.js`
- Create: `lang/en.json`
- Create: `styles/omnipresence.css`
- Create: `packs/omnipresence-actors/.gitkeep`

- [ ] **Step 1: Create `module.json`**

```json
{
  "id": "omnipresence",
  "title": "Omnipresence",
  "description": "Synchronize player characters across multiple worlds on the same Foundry server.",
  "version": "1.0.0",
  "authors": [{ "name": "Dan Bularzik" }],
  "compatibility": {
    "minimum": "13",
    "verified": "13"
  },
  "esmodules": ["omnipresence.js"],
  "styles": ["styles/omnipresence.css"],
  "languages": [
    {
      "lang": "en",
      "name": "English",
      "path": "lang/en.json"
    }
  ],
  "packs": [
    {
      "name": "omnipresence-actors",
      "label": "Omnipresence Shared Characters",
      "path": "packs/omnipresence-actors",
      "type": "Actor",
      "system": ""
    }
  ]
}
```

- [ ] **Step 2: Create `omnipresence.js` (stub)**

```javascript
import { SyncRegistry } from './scripts/sync-registry.js';
import { SyncEngine } from './scripts/sync-engine.js';
import { registerContextMenu } from './scripts/context-menu.js';
import { OmnipresenceDashboard } from './scripts/gm-dashboard.js';

Hooks.once('init', () => {
  SyncRegistry.register();

  game.settings.registerMenu('omnipresence', 'dashboard', {
    name: 'OMNIPRESENCE.settings.dashboard.name',
    label: 'OMNIPRESENCE.settings.dashboard.label',
    hint: 'OMNIPRESENCE.settings.dashboard.hint',
    icon: 'fas fa-link',
    type: OmnipresenceDashboard,
    restricted: false
  });
});

Hooks.once('ready', async () => {
  const pack = game.packs.get('omnipresence.omnipresence-actors');
  if (pack?.locked) await pack.configure({ locked: false });
  await SyncEngine.onLogin();
});

Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (userId !== game.user.id) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  SyncEngine.trackLocalModification(actor);
  SyncEngine.debouncedPush(actor);
});

Hooks.on('deleteActor', (actor, options, userId) => {
  if (!SyncRegistry.isEnrolled(actor)) return;
  SyncRegistry.unenroll(actor);
});

Hooks.on('closeWorld', async () => {
  await SyncEngine.flushPending();
});

Hooks.on('getActorDirectoryEntryContext', (html, entryOptions) => {
  registerContextMenu(entryOptions);
});
```

- [ ] **Step 3: Create `lang/en.json`**

```json
{
  "OMNIPRESENCE.settings.dashboard.name": "Omnipresence Sync",
  "OMNIPRESENCE.settings.dashboard.label": "Manage Sync",
  "OMNIPRESENCE.settings.dashboard.hint": "View and manage which characters are synchronized across worlds.",
  "OMNIPRESENCE.contextMenu.add": "Add to Omnipresence Sync",
  "OMNIPRESENCE.contextMenu.remove": "Remove from Omnipresence Sync",
  "OMNIPRESENCE.conflict.title": "Omnipresence — Sync Conflict",
  "OMNIPRESENCE.conflict.message": "<strong>{name}</strong> has been modified both here and in the shared compendium since your last sync. Which version would you like to keep?",
  "OMNIPRESENCE.conflict.keepLocal": "Keep Local Version",
  "OMNIPRESENCE.conflict.useShared": "Use Shared Version",
  "OMNIPRESENCE.conflict.warning": "The version you don't choose will be permanently overwritten.",
  "OMNIPRESENCE.dashboard.title": "Omnipresence Sync",
  "OMNIPRESENCE.dashboard.colActor": "Actor",
  "OMNIPRESENCE.dashboard.colOwner": "Owner",
  "OMNIPRESENCE.dashboard.colLastSynced": "Last Synced",
  "OMNIPRESENCE.dashboard.colActions": "Actions",
  "OMNIPRESENCE.dashboard.forcePush": "Force Push",
  "OMNIPRESENCE.dashboard.forcePull": "Force Pull",
  "OMNIPRESENCE.dashboard.remove": "Remove from Sync",
  "OMNIPRESENCE.dashboard.forceSyncAll": "Force Sync All",
  "OMNIPRESENCE.dashboard.addViaContextMenu": "To add characters, right-click them in the Actors Directory.",
  "OMNIPRESENCE.dashboard.conflict": "conflict",
  "OMNIPRESENCE.dashboard.never": "Never",
  "OMNIPRESENCE.notifications.syncFailed": "Omnipresence: sync failed for {name}. Check the console for details.",
  "OMNIPRESENCE.notifications.enrolled": "{name} added to Omnipresence sync.",
  "OMNIPRESENCE.notifications.unenrolled": "{name} removed from Omnipresence sync."
}
```

- [ ] **Step 4: Create `styles/omnipresence.css`**

```css
#omnipresence-dashboard .omnipresence-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

#omnipresence-dashboard .omnipresence-table th {
  text-align: left;
  padding: 6px 10px;
  background: rgba(0,0,0,0.2);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-dark-secondary, #888);
}

#omnipresence-dashboard .omnipresence-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--color-border-light-tertiary, #ddd);
  vertical-align: middle;
}

#omnipresence-dashboard .omnipresence-table tr.conflict td {
  background: rgba(232, 168, 56, 0.1);
}

#omnipresence-dashboard .conflict-badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(232, 168, 56, 0.3);
  color: #a07000;
  margin-left: 6px;
}

#omnipresence-dashboard .dashboard-footer {
  padding: 10px;
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid var(--color-border-light-tertiary, #ddd);
}

#omnipresence-dashboard .footer-hint {
  font-size: 12px;
  color: var(--color-text-dark-secondary, #888);
  text-align: center;
  padding: 10px;
}
```

- [ ] **Step 5: Create the compendium directory and placeholder**

```bash
mkdir -p packs/omnipresence-actors
touch packs/omnipresence-actors/.gitkeep
```

- [ ] **Step 6: Install the module in Foundry and verify it loads**

Place the entire `omnipresence/` directory in your Foundry `Data/modules/` folder. Launch Foundry, open a world, go to **Add-on Modules**, enable **Omnipresence**, and reload. Open the browser console — there should be no errors. The **Configure Settings** dialog should show an **Omnipresence Sync** button under Module Settings (it will error when clicked until Task 7 is complete — that's expected).

- [ ] **Step 7: Commit**

```bash
git add module.json omnipresence.js lang/en.json styles/omnipresence.css packs/omnipresence-actors/.gitkeep
git commit -m "feat: module scaffold — manifest, entry point, lang, styles"
```

---

## Task 2: SyncRegistry

**Files:**
- Create: `scripts/sync-registry.js`

- [ ] **Step 1: Create `scripts/sync-registry.js`**

```javascript
export class SyncRegistry {
  static SETTING = 'syncRegistry';

  static register() {
    game.settings.register('omnipresence', this.SETTING, {
      name: 'Sync Registry',
      scope: 'world',
      config: false,
      type: Object,
      default: {}
    });
  }

  static _getAll() {
    return game.settings.get('omnipresence', this.SETTING);
  }

  static isEnrolled(actor) {
    const id = actor.getFlag('omnipresence', 'id');
    if (!id) return false;
    return id in this._getAll();
  }

  static getEnrolledIds() {
    return Object.keys(this._getAll());
  }

  /** Returns the owner name to store in flags (non-GM owner, or null). */
  static resolveOwnerName(actor) {
    for (const [userId, level] of Object.entries(actor.ownership ?? {})) {
      if (userId === 'default') continue;
      if (level < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) continue;
      const user = game.users.get(userId);
      if (user && !user.isGM) return user.name;
    }
    if (actor.isOwner && !game.user.isGM) return game.user.name;
    return null;
  }

  static async enroll(actor) {
    let id = actor.getFlag('omnipresence', 'id');
    if (!id) {
      id = foundry.utils.randomID(16);
      const ownerName = this.resolveOwnerName(actor);
      const now = new Date().toISOString();
      await actor.update({
        'flags.omnipresence.id': id,
        'flags.omnipresence.ownerName': ownerName,
        'flags.omnipresence.syncedAt': now,
        'flags.omnipresence.localModifiedAt': now
      }, { omnipresenceInternal: true });
    }
    const registry = this._getAll();
    registry[id] = true;
    await game.settings.set('omnipresence', this.SETTING, registry);
    return id;
  }

  static async unenroll(actor) {
    const id = actor.getFlag('omnipresence', 'id');
    if (!id) return;
    const registry = this._getAll();
    delete registry[id];
    await game.settings.set('omnipresence', this.SETTING, registry);
  }
}
```

- [ ] **Step 2: Verify in browser console**

In the Foundry console, run:
```javascript
const actor = game.actors.getName('Test Character'); // any actor
await game.omnipresence?.registry?.enroll(actor);    // won't work yet — test via import
```

Instead, paste this in the console to smoke-test the registry directly:
```javascript
// This simulates what enroll will do — verify no errors
game.settings.get('omnipresence', 'syncRegistry'); // should return {}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-registry.js
git commit -m "feat: SyncRegistry — world-scoped enrollment tracking"
```

---

## Task 3: Context Menu

**Files:**
- Create: `scripts/context-menu.js`

- [ ] **Step 1: Create `scripts/context-menu.js`**

```javascript
import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';

export function registerContextMenu(entryOptions) {
  entryOptions.push(
    {
      name: 'OMNIPRESENCE.contextMenu.add',
      icon: '<i class="fas fa-link"></i>',
      condition: (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return !SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return;
        await SyncRegistry.enroll(actor);
        await SyncEngine.push(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.enrolled', { name: actor.name }));
      }
    },
    {
      name: 'OMNIPRESENCE.contextMenu.remove',
      icon: '<i class="fas fa-unlink"></i>',
      condition: (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return false;
        if (!game.user.isGM && !actor.isOwner) return false;
        return SyncRegistry.isEnrolled(actor);
      },
      callback: async (li) => {
        const actor = game.actors.get(li.data('documentId'));
        if (!actor) return;
        await SyncRegistry.unenroll(actor);
        ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
      }
    }
  );
}
```

- [ ] **Step 2: Verify in Foundry**

Right-click an actor in the Actors Directory. You should see **"Add to Omnipresence Sync"** (since it's not enrolled). Click it — the notification "X added to Omnipresence sync" should appear. Right-click again — it should now show **"Remove from Omnipresence Sync"**. Note: the push in Step 1 will error until Task 4 is complete — wrap `SyncEngine.push` in a try/catch temporarily if needed.

- [ ] **Step 3: Commit**

```bash
git add scripts/context-menu.js
git commit -m "feat: context menu — enroll/unenroll actors via right-click"
```

---

## Task 4: SyncEngine — Push

**Files:**
- Create: `scripts/sync-engine.js`

- [ ] **Step 1: Create `scripts/sync-engine.js` with push and debounce**

```javascript
import { SyncRegistry } from './sync-registry.js';

const PACK_ID = 'omnipresence.omnipresence-actors';
const DEBOUNCE_MS = 2000;

export class SyncEngine {
  static _timers = new Map();   // actorId → timeout handle
  static _pending = new Map();  // actorId → actor (for flush on logout)

  static _getPack() {
    return game.packs.get(PACK_ID);
  }

  static async _getCompendiumActor(omnipresenceId) {
    const pack = this._getPack();
    if (!pack) return null;
    const docs = await pack.getDocuments();
    return docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId) ?? null;
  }

  static async push(actor) {
    const pack = this._getPack();
    if (!pack) {
      console.warn('Omnipresence | compendium pack not found:', PACK_ID);
      return;
    }

    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    if (!omnipresenceId) return;

    const syncedAt = new Date().toISOString();
    const actorData = actor.toObject();

    // Strip world-local metadata before writing to compendium
    delete actorData.flags?.omnipresence?.localModifiedAt;
    actorData.flags.omnipresence.syncedAt = syncedAt;

    try {
      const existing = await this._getCompendiumActor(omnipresenceId);
      if (existing) {
        // Preserve the compendium document's own _id
        const { _id, ...rest } = actorData;
        await existing.update(rest);
      } else {
        delete actorData._id;
        await Actor.create(actorData, { pack: PACK_ID });
      }

      // Update local syncedAt to match (do not touch localModifiedAt)
      await actor.update(
        { 'flags.omnipresence.syncedAt': syncedAt },
        { omnipresenceInternal: true }
      );

      this._pending.delete(actor.id);
    } catch (err) {
      console.error('Omnipresence | push failed for', actor.name, err);
      ui.notifications.warn(
        game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: actor.name })
      );
    }
  }

  static debouncedPush(actor) {
    const id = actor.id;
    if (this._timers.has(id)) clearTimeout(this._timers.get(id));
    this._pending.set(id, actor);
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this.push(actor);
    }, DEBOUNCE_MS);
    this._timers.set(id, timer);
  }

  static async trackLocalModification(actor) {
    await actor.update(
      { 'flags.omnipresence.localModifiedAt': new Date().toISOString() },
      { omnipresenceInternal: true }
    );
  }

  static async flushPending() {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const [id, timer] of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
    await Promise.all(pending.map(actor => this.push(actor)));
  }

  // Stub — implemented in Task 5
  static async onLogin() {}
}
```

- [ ] **Step 2: Verify push in Foundry**

1. Enroll a test actor via context menu (Task 3).
2. Edit the actor (change name or any stat).
3. Wait 2 seconds.
4. Open **Compendium Packs** in Foundry — find **Omnipresence Shared Characters**.
5. The actor should appear in the compendium with matching data.

- [ ] **Step 3: Commit**

```bash
git add scripts/sync-engine.js
git commit -m "feat: SyncEngine push — debounced compendium write on actor update"
```

---

## Task 5: SyncEngine — Login Pull + Auto-Import

**Files:**
- Modify: `scripts/sync-engine.js`

- [ ] **Step 1: Add `pull` and `onLogin` to `SyncEngine`**

Replace the `// Stub — implemented in Task 5` comment and `static async onLogin() {}` line with:

```javascript
  static async pull(localActor, compActor) {
    const actorData = compActor.toObject();
    delete actorData._id;
    // Reset localModifiedAt to match the pulled syncedAt (no local changes outstanding)
    actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
    await localActor.update(actorData, { omnipresenceInternal: true });
  }

  static async onLogin() {
    const pack = this._getPack();
    if (!pack) return;

    const compActors = await pack.getDocuments();
    const enrolledIds = new Set(SyncRegistry.getEnrolledIds());
    const myActors = game.actors.filter(a => a.isOwner && SyncRegistry.isEnrolled(a));

    // 1. Sync each of the current user's enrolled actors
    for (const actor of myActors) {
      const omnipresenceId = actor.getFlag('omnipresence', 'id');
      const compActor = compActors.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);

      if (!compActor) {
        // No compendium entry — push local copy as master
        await this.push(actor);
        continue;
      }

      const localSyncedAt = actor.getFlag('omnipresence', 'syncedAt');
      const compSyncedAt = compActor.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = actor.getFlag('omnipresence', 'localModifiedAt') ?? localSyncedAt;

      const localSyncTime = localSyncedAt ? new Date(localSyncedAt).getTime() : 0;
      const compSyncTime = compSyncedAt ? new Date(compSyncedAt).getTime() : 0;
      const localModTime = localModifiedAt ? new Date(localModifiedAt).getTime() : 0;

      const compNewer = compSyncTime > localSyncTime;
      const localChanged = localModTime > localSyncTime;

      if (compNewer && localChanged) {
        // Both sides have changes — prompt user
        const { ConflictResolver } = await import('./conflict-resolver.js');
        await ConflictResolver.resolve(actor, compActor, {
          onKeepLocal: () => this.push(actor),
          onUseShared: () => this.pull(actor, compActor)
        });
      } else if (compNewer) {
        await this.pull(actor, compActor);
      } else if (localSyncTime > compSyncTime) {
        await this.push(actor);
      }
      // else: in sync
    }

    // 2. Auto-import: compendium actors not present in this world
    const localOmnipresenceIds = new Set(
      game.actors
        .filter(a => a.getFlag('omnipresence', 'id'))
        .map(a => a.getFlag('omnipresence', 'id'))
    );

    for (const compActor of compActors) {
      const omnipresenceId = compActor.getFlag('omnipresence', 'id');
      if (!omnipresenceId) continue;
      if (localOmnipresenceIds.has(omnipresenceId)) continue;

      const ownerName = compActor.getFlag('omnipresence', 'ownerName');
      if (!ownerName) {
        console.warn('Omnipresence | compendium actor has no ownerName, skipping auto-import:', compActor.name);
        continue;
      }

      const matchingUser = game.users.find(u => u.name === ownerName);
      if (!matchingUser) {
        console.warn('Omnipresence | no user named', ownerName, '— skipping auto-import of', compActor.name);
        continue;
      }

      const actorData = compActor.toObject();
      delete actorData._id;
      actorData.flags.omnipresence.localModifiedAt = actorData.flags.omnipresence.syncedAt;
      actorData.ownership = { default: 0, [matchingUser.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };

      const created = await Actor.create(actorData);
      await SyncRegistry.enroll(created);
    }
  }
```

- [ ] **Step 2: Verify silent pull**

1. Enroll an actor in World A, make an edit (it pushes to compendium).
2. Switch to World B (same server). The actor should appear in the Actors Directory automatically on login, owned by the correct user.

- [ ] **Step 3: Verify push-on-login (local newer)**

1. In World B, unenroll the actor, make edits to the local copy, re-enroll.
2. Manipulate `syncedAt` in the compendium entry to be older (via console: `pack.getDocuments()` then `doc.update(...)`) to simulate the stale case.
3. Log out and back in — module should push the local copy up.

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-engine.js
git commit -m "feat: SyncEngine login sync — pull, push, and auto-import on ready"
```

---

## Task 6: ConflictResolver

**Files:**
- Create: `scripts/conflict-resolver.js`

- [ ] **Step 1: Create `scripts/conflict-resolver.js`**

```javascript
export class ConflictResolver {
  /**
   * Prompt the user to resolve a sync conflict.
   * Calls onKeepLocal() or onUseShared() depending on the user's choice.
   * Does not import SyncEngine — callers pass the callbacks to avoid circular deps.
   */
  static async resolve(localActor, compActor, { onKeepLocal, onUseShared }) {
    const localSyncedAt = localActor.getFlag('omnipresence', 'syncedAt') ?? '';
    const compSyncedAt = compActor.getFlag('omnipresence', 'syncedAt') ?? '';

    const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '—';

    const content = `
      <div style="margin-bottom:12px">
        ${game.i18n.format('OMNIPRESENCE.conflict.message', { name: localActor.name })}
      </div>
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <div style="flex:1;border:1px solid var(--color-border-light-tertiary);border-radius:4px;padding:10px">
          <div style="font-size:11px;font-weight:bold;text-transform:uppercase;margin-bottom:4px">
            ${game.i18n.localize('OMNIPRESENCE.conflict.keepLocal')}
          </div>
          <div style="font-size:12px;color:var(--color-text-dark-secondary)">${fmt(localSyncedAt)}</div>
        </div>
        <div style="flex:1;border:1px solid var(--color-border-light-tertiary);border-radius:4px;padding:10px">
          <div style="font-size:11px;font-weight:bold;text-transform:uppercase;margin-bottom:4px">
            ${game.i18n.localize('OMNIPRESENCE.conflict.useShared')}
          </div>
          <div style="font-size:12px;color:var(--color-text-dark-secondary)">${fmt(compSyncedAt)}</div>
        </div>
      </div>
      <p style="font-size:11px;color:var(--color-text-dark-secondary);text-align:center">
        ${game.i18n.localize('OMNIPRESENCE.conflict.warning')}
      </p>
    `;

    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize('OMNIPRESENCE.conflict.title') },
      content,
      modal: true,
      buttons: [
        {
          action: 'local',
          label: game.i18n.localize('OMNIPRESENCE.conflict.keepLocal'),
          default: true
        },
        {
          action: 'shared',
          label: game.i18n.localize('OMNIPRESENCE.conflict.useShared')
        }
      ]
    });

    if (choice === 'local') {
      await onKeepLocal();
    } else {
      await onUseShared();
    }
  }
}
```

- [ ] **Step 2: Verify conflict dialog**

To trigger a conflict manually:
1. Enroll an actor in World A. Note its `syncedAt` flag.
2. In the browser console (World A), update the actor's local `localModifiedAt` to be newer than `syncedAt`:
   ```javascript
   const a = game.actors.getName('Test');
   await a.update({'flags.omnipresence.localModifiedAt': new Date().toISOString()}, {omnipresenceInternal: true});
   ```
3. In the compendium, find the same actor and update its `syncedAt` to be even newer:
   ```javascript
   const pack = game.packs.get('omnipresence.omnipresence-actors');
   const docs = await pack.getDocuments();
   const ca = docs[0];
   await ca.update({'flags.omnipresence.syncedAt': new Date().toISOString()});
   ```
4. Reload the world. The conflict dialog should appear. Test both choices.

- [ ] **Step 3: Commit**

```bash
git add scripts/conflict-resolver.js
git commit -m "feat: ConflictResolver — DialogV2 prompt for both-sides-changed sync"
```

---

## Task 7: GMDashboard

**Files:**
- Create: `scripts/gm-dashboard.js`
- Create: `templates/settings-panel.hbs`

- [ ] **Step 1: Create `templates/settings-panel.hbs`**

```handlebars
<div id="omnipresence-dashboard">
  {{#if isGM}}
  <table class="omnipresence-table">
    <thead>
      <tr>
        <th>{{localize "OMNIPRESENCE.dashboard.colActor"}}</th>
        <th>{{localize "OMNIPRESENCE.dashboard.colOwner"}}</th>
        <th>{{localize "OMNIPRESENCE.dashboard.colLastSynced"}}</th>
        <th>{{localize "OMNIPRESENCE.dashboard.colActions"}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each actors}}
      <tr class="{{#if this.hasConflict}}conflict{{/if}}" data-actor-id="{{this.id}}">
        <td>
          {{this.name}}
          {{#if this.hasConflict}}
          <span class="conflict-badge">{{localize "OMNIPRESENCE.dashboard.conflict"}}</span>
          {{/if}}
        </td>
        <td>{{this.ownerName}}</td>
        <td>{{this.syncedAtFormatted}}</td>
        <td>
          <a data-action="forcePush" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.forcePush"}}"><i class="fas fa-upload"></i></a>
          <a data-action="forcePull" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.forcePull"}}"><i class="fas fa-download"></i></a>
          <a data-action="removeSync" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.remove"}}" style="color:#c0392b"><i class="fas fa-unlink"></i></a>
        </td>
      </tr>
      {{else}}
      <tr><td colspan="4" style="text-align:center;padding:16px;color:var(--color-text-dark-secondary)">No actors enrolled in sync.</td></tr>
      {{/each}}
    </tbody>
  </table>
  <div class="dashboard-footer">
    <button type="button" data-action="forceSyncAll">
      <i class="fas fa-sync"></i> {{localize "OMNIPRESENCE.dashboard.forceSyncAll"}}
    </button>
  </div>
  {{else}}
  <table class="omnipresence-table">
    <thead>
      <tr>
        <th>{{localize "OMNIPRESENCE.dashboard.colActor"}}</th>
        <th>{{localize "OMNIPRESENCE.dashboard.colLastSynced"}}</th>
        <th>{{localize "OMNIPRESENCE.dashboard.colActions"}}</th>
      </tr>
    </thead>
    <tbody>
      {{#each actors}}
      <tr class="{{#if this.hasConflict}}conflict{{/if}}" data-actor-id="{{this.id}}">
        <td>
          {{this.name}}
          {{#if this.hasConflict}}
          <span class="conflict-badge">{{localize "OMNIPRESENCE.dashboard.conflict"}}</span>
          {{/if}}
        </td>
        <td>{{this.syncedAtFormatted}}</td>
        <td>
          <a data-action="removeSync" data-actor-id="{{this.id}}" title="{{localize "OMNIPRESENCE.dashboard.remove"}}" style="color:#c0392b"><i class="fas fa-unlink"></i></a>
        </td>
      </tr>
      {{else}}
      <tr><td colspan="3" style="text-align:center;padding:16px;color:var(--color-text-dark-secondary)">No actors enrolled in sync.</td></tr>
      {{/each}}
    </tbody>
  </table>
  <p class="footer-hint">{{localize "OMNIPRESENCE.dashboard.addViaContextMenu"}}</p>
  {{/if}}
</div>
```

- [ ] **Step 2: Create `scripts/gm-dashboard.js`**

```javascript
import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class OmnipresenceDashboard extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'omnipresence-dashboard',
    classes: ['omnipresence'],
    window: {
      title: 'OMNIPRESENCE.dashboard.title',
      resizable: true
    },
    position: {
      width: 620,
      height: 'auto'
    },
    actions: {
      forcePush: OmnipresenceDashboard._onForcePush,
      forcePull: OmnipresenceDashboard._onForcePull,
      removeSync: OmnipresenceDashboard._onRemoveSync,
      forceSyncAll: OmnipresenceDashboard._onForceSyncAll
    }
  };

  static PARTS = {
    main: {
      template: 'modules/omnipresence/templates/settings-panel.hbs'
    }
  };

  async _prepareContext(options) {
    const isGM = game.user.isGM;
    const allActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    const visibleActors = isGM ? allActors : allActors.filter(a => a.isOwner);

    const actors = visibleActors.map(a => {
      const syncedAt = a.getFlag('omnipresence', 'syncedAt');
      const localModifiedAt = a.getFlag('omnipresence', 'localModifiedAt') ?? syncedAt;
      const hasConflict = localModifiedAt > syncedAt;
      return {
        id: a.id,
        name: a.name,
        ownerName: a.getFlag('omnipresence', 'ownerName') ?? '—',
        syncedAtFormatted: syncedAt ? new Date(syncedAt).toLocaleString() : game.i18n.localize('OMNIPRESENCE.dashboard.never'),
        hasConflict
      };
    });

    return { isGM, actors };
  }

  static async _onForcePush(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    await SyncEngine.push(actor);
    this.render();
  }

  static async _onForcePull(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    const omnipresenceId = actor.getFlag('omnipresence', 'id');
    const pack = game.packs.get('omnipresence.omnipresence-actors');
    if (!pack) return;
    const docs = await pack.getDocuments();
    const compActor = docs.find(d => d.getFlag('omnipresence', 'id') === omnipresenceId);
    if (!compActor) return;
    await SyncEngine.pull(actor, compActor);
    this.render();
  }

  static async _onRemoveSync(event, target) {
    const actorId = target.closest('[data-actor-id]').dataset.actorId;
    const actor = game.actors.get(actorId);
    if (!actor) return;
    await SyncRegistry.unenroll(actor);
    ui.notifications.info(game.i18n.format('OMNIPRESENCE.notifications.unenrolled', { name: actor.name }));
    this.render();
  }

  static async _onForceSyncAll(event, target) {
    const enrolledActors = game.actors.filter(a => SyncRegistry.isEnrolled(a));
    await Promise.all(enrolledActors.map(a => SyncEngine.push(a)));
    this.render();
  }
}
```

- [ ] **Step 3: Verify the dashboard**

Open **Configure Settings** → **Module Settings** → click **Manage Sync**. The dashboard should open. Enroll two actors first (Task 3), then verify:
- Both actors appear in the table
- Force Push updates the compendium entry (check timestamp in Compendium browser)
- Force Pull overwrites the local actor
- Remove unenrolls the actor (right-click context menu should show "Add" again)
- Force Sync All pushes all enrolled actors (no errors in console)
- As a player (non-GM user), only own actors appear and only the remove action is shown

- [ ] **Step 4: Commit**

```bash
git add scripts/gm-dashboard.js templates/settings-panel.hbs
git commit -m "feat: GMDashboard — ApplicationV2 settings panel for GM and player views"
```

---

## Task 8: deleteActor Hook + Flush on Logout

These behaviors are already wired in `omnipresence.js` from Task 1. This task verifies they work correctly end-to-end.

**Files:**
- No new files — verify existing hooks in `omnipresence.js`

- [ ] **Step 1: Verify deleteActor cleanup**

1. Enroll a test actor.
2. Verify it appears in the sync registry: `game.settings.get('omnipresence', 'syncRegistry')` — should contain its UUID.
3. Delete the actor from the Actors Directory.
4. Check registry again — UUID should be gone.
5. The compendium entry should still exist (open Compendium Packs to confirm).
6. Log out and back in — the actor should be auto-imported from the compendium and re-enrolled.

- [ ] **Step 2: Verify flush on logout**

1. Enroll an actor and make a rapid series of edits.
2. Immediately log out (before the 2s debounce fires).
3. Log back in.
4. Open the compendium — the actor should reflect the latest edits (flush fired on logout).

- [ ] **Step 3: Run the full test matrix**

Work through each scenario from the spec:

| Test | Expected |
|---|---|
| Enroll via context menu (as player) | Notification appears; actor in compendium |
| Enroll via context menu (as GM, another player's actor) | Same as above |
| Unenroll via context menu | Notification; actor no longer tracked |
| Edit enrolled actor | Compendium updates within ~2s |
| Login — compendium newer, local unchanged | Silent pull |
| Login — conflict (both changed) | ConflictResolver dialog; chosen version wins |
| Login — compendium actor not in world | Actor auto-created with correct ownership |
| GM dashboard — force push | Compendium updates immediately |
| GM dashboard — force pull | Local actor updated immediately |
| GM dashboard — remove | Actor unenrolled |
| GM dashboard — Force Sync All | All enrolled actors pushed |
| Player settings panel | Only own actors; only remove action |
| Delete enrolled actor | Registry cleared; compendium entry intact |
| Rapid edits then logout | All changes captured in compendium |

- [ ] **Step 4: Final commit**

```bash
git add .
git commit -m "feat: verify delete and flush hooks — full test matrix passing"
```
