# Macro Hotbar Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize each player's hotbar macros across Foundry worlds via a shared Macro compendium, with per-user opt-in controls injected into the standard User Configuration dialog.

**Architecture:** A new system-agnostic `omnipresence-macros` compendium pack is the shared store; each entry carries `omnipresence.{id, ownerName, hotbarSlots}` flags. `MacroSync` mirrors the existing `SyncEngine` pattern — GM clients relay all compendium writes, players pull on login. A `renderUserConfig` hook injects an "Omnipresence" fieldset with actor-sync and macro-sync checkboxes that save immediately to a new `syncPrefs` world setting.

**Tech Stack:** Plain ES modules, Foundry VTT v13, Playwright MCP for automated browser tests.

## Global Constraints

- Foundry v13 only; no build step; all files are ES modules loaded directly by Foundry
- `omnipresenceInternal: true` on every internal document write (prevents sync loops)
- All compendium writes are GM-only; bail immediately on non-GM clients
- `scripts/sync-logic.js` must remain Foundry-independent (no `game`/`Hooks`/`CONST`/`ui`)
- Before each browser test: copy changed files to `~/FoundryVTT/Data/Data/modules/omnipresence`
- Foundry server: `~/FoundryVTT/start-foundry.command` → `http://localhost:30000`
- **Note on `syncPrefs` scope:** `syncPrefs` is a `scope: 'world'` setting and Foundry user `_id`s are world-local. A preference set in World A does not carry to World B (the GM has a different userId in each world). This is expected and acceptable.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `packs/omnipresence-macros/` | Empty directory; Foundry initialises the LevelDB store on first access |
| Create | `scripts/macro-sync.js` | `MacroSync` class: push, pull, debounce, opt-in checks |
| Create | `scripts/user-config.js` | `renderUserConfig` hook injection; save-on-change checkboxes |
| Modify | `module.json` | Add `omnipresence-macros` pack entry |
| Modify | `scripts/sync-registry.js` | Register `syncPrefs` setting; add `getPrefs`, `setPrefs`, `isActorSyncEnabled`, `isMacroSyncEnabled` |
| Modify | `scripts/sync-engine.js` | Bail from `onLogin()` when actor sync is paused |
| Modify | `scripts/context-menu.js` | Hide both menu items when actor sync is paused |
| Modify | `omnipresence.js` | Import `MacroSync` + `registerUserConfigInjection`; add `updateMacro`, `updateUser` hooks; unlock macro pack; call `MacroSync.onLogin()` |
| Modify | `lang/en.json` | Add i18n strings for the User Config fieldset |

---

### Task 1: Foundation — pack + syncPrefs setting

**Files:**
- Create: `packs/omnipresence-macros/`
- Modify: `module.json`
- Modify: `scripts/sync-registry.js`
- Modify: `lang/en.json`

**Interfaces:**
- Produces: `SyncRegistry.getPrefs(userId)`, `SyncRegistry.setPrefs(userId, prefs)`, `SyncRegistry.isActorSyncEnabled(userId)`, `SyncRegistry.isMacroSyncEnabled(userId)` — consumed by every subsequent task

---

- [ ] **Step 1: Create the empty pack directory**

```bash
mkdir packs/omnipresence-macros
```

- [ ] **Step 2: Add the Macro pack to `module.json`**

Add as the last entry in the `"packs"` array:

```json
{ "name": "omnipresence-macros", "type": "Macro", "path": "packs/omnipresence-macros", "label": "Omnipresence — Macros" }
```

Full `"packs"` array after edit:

```json
"packs": [
  { "name": "omnipresence-dnd5e",       "type": "Actor", "system": "dnd5e",       "path": "packs/omnipresence-dnd5e",       "label": "Omnipresence — D&D 5e" },
  { "name": "omnipresence-pf2e",        "type": "Actor", "system": "pf2e",        "path": "packs/omnipresence-pf2e",        "label": "Omnipresence — Pathfinder 2e" },
  { "name": "omnipresence-daggerheart", "type": "Actor", "system": "daggerheart", "path": "packs/omnipresence-daggerheart", "label": "Omnipresence — Daggerheart" },
  { "name": "omnipresence-draw-steel",  "type": "Actor", "system": "draw-steel",  "path": "packs/omnipresence-draw-steel",  "label": "Omnipresence — Draw Steel" },
  { "name": "omnipresence-shadowdark",  "type": "Actor", "system": "shadowdark",  "path": "packs/omnipresence-shadowdark",  "label": "Omnipresence — Shadowdark" },
  { "name": "omnipresence-CoC7",        "type": "Actor", "system": "CoC7",        "path": "packs/omnipresence-CoC7",        "label": "Omnipresence — Call of Cthulhu 7e" },
  { "name": "omnipresence-macros",      "type": "Macro", "path": "packs/omnipresence-macros", "label": "Omnipresence — Macros" }
],
```

- [ ] **Step 3: Add `syncPrefs` setting and helpers to `scripts/sync-registry.js`**

Add `static PREFS_SETTING = 'syncPrefs';` after the existing `static SETTING = 'syncRegistry';` line.

In `SyncRegistry.register()`, after the existing `game.settings.register(...)` call, add:

```javascript
game.settings.register('omnipresence', this.PREFS_SETTING, {
  name: 'Sync Preferences',
  scope: 'world',
  config: false,
  type: Object,
  default: {}
});
```

Add these four static methods to the class:

```javascript
static getPrefs(userId) {
  const all = game.settings.get('omnipresence', this.PREFS_SETTING);
  return all[userId] ?? { actors: true, macros: true };
}

static async setPrefs(userId, prefs) {
  const all = game.settings.get('omnipresence', this.PREFS_SETTING);
  all[userId] = { ...(all[userId] ?? { actors: true, macros: true }), ...prefs };
  await game.settings.set('omnipresence', this.PREFS_SETTING, all);
}

static isActorSyncEnabled(userId) {
  return this.getPrefs(userId).actors !== false;
}

static isMacroSyncEnabled(userId) {
  return this.getPrefs(userId).macros !== false;
}
```

- [ ] **Step 4: Add i18n strings to `lang/en.json`**

Add before the closing `}`:

```json
  "OMNIPRESENCE.userConfig.legend": "Omnipresence",
  "OMNIPRESENCE.userConfig.actorSync": "Synchronize player characters across worlds",
  "OMNIPRESENCE.userConfig.macroSync": "Synchronize hotbar macros across worlds"
```

- [ ] **Step 5: Copy to module directory**

```bash
cp module.json ~/FoundryVTT/Data/Data/modules/omnipresence/
cp scripts/sync-registry.js ~/FoundryVTT/Data/Data/modules/omnipresence/scripts/
cp lang/en.json ~/FoundryVTT/Data/Data/modules/omnipresence/lang/
mkdir -p ~/FoundryVTT/Data/Data/modules/omnipresence/packs/omnipresence-macros
```

- [ ] **Step 6: Verify in Foundry (Playwright MCP)**

Start Foundry (`~/FoundryVTT/start-foundry.command`). Navigate to `http://localhost:30000`, log into World A as Gamemaster. Run via `browser_evaluate`:

```javascript
return {
  prefs: game.settings.get('omnipresence', 'syncPrefs'),
  pack: !!game.packs.get('omnipresence.omnipresence-macros')
};
```

Expected: `{ prefs: {}, pack: true }`

- [ ] **Step 7: Commit**

```bash
git add module.json scripts/sync-registry.js lang/en.json packs/omnipresence-macros/
git commit -m "feat: add omnipresence-macros pack and syncPrefs setting"
```

---

### Task 2: User Configuration UI injection

**Files:**
- Create: `scripts/user-config.js`
- Modify: `omnipresence.js`

**Interfaces:**
- Consumes: `SyncRegistry.getPrefs(userId)`, `SyncRegistry.setPrefs(userId, prefs)` from Task 1
- Produces: `registerUserConfigInjection()` — called from `omnipresence.js` `init` hook

---

- [ ] **Step 1: Create `scripts/user-config.js`**

```javascript
import { SyncRegistry } from './sync-registry.js';

export function registerUserConfigInjection() {
  Hooks.on('renderUserConfig', (app, html) => {
    // v13 ApplicationV2 passes an HTMLElement; guard against jQuery (v12 legacy).
    const root = html instanceof HTMLElement ? html : html[0];
    const userPrefs = SyncRegistry.getPrefs(game.user.id);

    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = `
      <legend>${game.i18n.localize('OMNIPRESENCE.userConfig.legend')}</legend>
      <div class="form-group">
        <label>
          <input type="checkbox" name="omnipresence-actors"${userPrefs.actors !== false ? ' checked' : ''}>
          ${game.i18n.localize('OMNIPRESENCE.userConfig.actorSync')}
        </label>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" name="omnipresence-macros"${userPrefs.macros !== false ? ' checked' : ''}>
          ${game.i18n.localize('OMNIPRESENCE.userConfig.macroSync')}
        </label>
      </div>
    `;

    // Insert before the footer / submit button group.
    const form = root.querySelector('form') ?? root;
    const footer = root.querySelector('.form-footer, footer, .window-footer');
    form.insertBefore(fieldset, footer);

    fieldset.querySelector('[name="omnipresence-actors"]').addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { actors: e.target.checked });
    });

    fieldset.querySelector('[name="omnipresence-macros"]').addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { macros: e.target.checked });
    });
  });
}
```

- [ ] **Step 2: Wire into `omnipresence.js`**

Add import at the top with the other imports:

```javascript
import { registerUserConfigInjection } from './scripts/user-config.js';
```

At the end of the `Hooks.once('init', ...)` callback body, add:

```javascript
registerUserConfigInjection();
```

- [ ] **Step 3: Copy to module directory**

```bash
cp scripts/user-config.js ~/FoundryVTT/Data/Data/modules/omnipresence/scripts/
cp omnipresence.js ~/FoundryVTT/Data/Data/modules/omnipresence/
```

- [ ] **Step 4: Verify fieldset appears (Playwright MCP)**

Reload Foundry (`Ctrl+Shift+R` in browser or restart). Log into World A as Gamemaster.

Click the Gamemaster avatar / username to open User Configuration. Take a snapshot via `browser_snapshot` — the "Omnipresence" fieldset with both checkboxes checked must be visible.

- [ ] **Step 5: Verify save-on-change (Playwright MCP)**

With User Configuration open, uncheck "Synchronize hotbar macros across worlds". Close the dialog. Run:

```javascript
return game.settings.get('omnipresence', 'syncPrefs')[game.user.id];
```

Expected: `{ actors: true, macros: false }`

Re-open User Configuration — "Synchronize hotbar macros" must appear unchecked (preference persisted). Re-check it and close.

- [ ] **Step 6: Commit**

```bash
git add scripts/user-config.js omnipresence.js
git commit -m "feat: inject Omnipresence sync toggles into User Configuration dialog"
```

---

### Task 3: Actor sync opt-in (pause behavior)

**Files:**
- Modify: `omnipresence.js`
- Modify: `scripts/sync-engine.js`
- Modify: `scripts/context-menu.js`

**Interfaces:**
- Consumes: `SyncRegistry.isActorSyncEnabled(userId)` from Task 1

---

- [ ] **Step 1: Add opt-in check to `updateActor` hook in `omnipresence.js`**

Replace the existing `updateActor` hook:

```javascript
Hooks.on('updateActor', (actor, changes, options, userId) => {
  if (options?.omnipresenceInternal) return;
  if (!SyncRegistry.isEnrolled(actor)) return;
  if (!SyncRegistry.isActorSyncEnabled(userId)) return;
  if (userId === game.user.id) SyncEngine.trackLocalModification(actor);
  if (game.user.isGM) SyncEngine.debouncedPush(actor);
});
```

- [ ] **Step 2: Add opt-in check to `SyncEngine.onLogin()` in `scripts/sync-engine.js`**

Immediately after the `if (!pack) { … return; }` guard block and before `const compActors = await pack.getDocuments();`, add:

```javascript
if (!SyncRegistry.isActorSyncEnabled(game.user.id)) return;
```

- [ ] **Step 3: Add opt-in check to both `condition` functions in `scripts/context-menu.js`**

Replace the `condition` for the "add" entry:

```javascript
condition: (li) => {
  if (!syncAvailable()) return false;
  if (!SyncRegistry.isActorSyncEnabled(game.user.id)) return false;
  const actor = game.actors.get(getDocumentId(li));
  if (!actor) return false;
  if (!game.user.isGM && !actor.isOwner) return false;
  return !SyncRegistry.isEnrolled(actor);
},
```

Replace the `condition` for the "remove" entry:

```javascript
condition: (li) => {
  if (!syncAvailable()) return false;
  if (!SyncRegistry.isActorSyncEnabled(game.user.id)) return false;
  const actor = game.actors.get(getDocumentId(li));
  if (!actor) return false;
  if (!game.user.isGM && !actor.isOwner) return false;
  return SyncRegistry.isEnrolled(actor);
},
```

- [ ] **Step 4: Copy to module directory**

```bash
cp omnipresence.js ~/FoundryVTT/Data/Data/modules/omnipresence/
cp scripts/sync-engine.js ~/FoundryVTT/Data/Data/modules/omnipresence/scripts/
cp scripts/context-menu.js ~/FoundryVTT/Data/Data/modules/omnipresence/scripts/
```

- [ ] **Step 5: Verify context menu hidden (Playwright MCP)**

Log into World A as Gamemaster. Open User Configuration, uncheck "Synchronize player characters across worlds", close.

Right-click any actor in the Actors Directory. Take a snapshot — neither "Add to Omnipresence Sync" nor "Remove from Omnipresence Sync" should appear.

- [ ] **Step 6: Verify no push when paused (Playwright MCP)**

With actor sync still paused: find an enrolled actor (one with `flags.omnipresence.id` set), open its sheet, change its name, save. Wait 3 seconds. Run:

```javascript
const actor = game.actors.find(a => a.getFlag('omnipresence', 'id'));
const pack = game.packs.get('omnipresence.omnipresence-dnd5e');
const compDocs = await pack.getDocuments();
const comp = compDocs.find(d => d.getFlag('omnipresence', 'id') === actor?.getFlag('omnipresence', 'id'));
return { localName: actor?.name, compName: comp?.name };
```

Expected: `localName` differs from `compName` (the push was suppressed).

Re-check "Synchronize player characters" in User Configuration.

- [ ] **Step 7: Commit**

```bash
git add omnipresence.js scripts/sync-engine.js scripts/context-menu.js
git commit -m "feat: respect actor sync opt-in in hooks, onLogin, and context menu"
```

---

### Task 4: MacroSync push path

**Files:**
- Create: `scripts/macro-sync.js`
- Modify: `omnipresence.js`

**Interfaces:**
- Consumes: `SyncRegistry.isMacroSyncEnabled(userId)` from Task 1
- Produces: `MacroSync.PACK_ID`, `MacroSync.handleMacroChange(macro)`, `MacroSync.handleHotbarChange(user)`, `MacroSync.onLogin()` (stub, filled in Task 5)

---

- [ ] **Step 1: Create `scripts/macro-sync.js`**

```javascript
import { SyncRegistry } from './sync-registry.js';

const DEBOUNCE_MS = 2000;

export class MacroSync {
  static _timers = new Map(); // userId → timeout handle

  static get PACK_ID() {
    return 'omnipresence.omnipresence-macros';
  }

  static _getPack() {
    return game.packs.get(this.PACK_ID);
  }

  /** Opted-in users who have `macroId` in their hotbar. */
  static _getUsersWithMacro(macroId) {
    return game.users.filter(u =>
      SyncRegistry.isMacroSyncEnabled(u.id) &&
      Object.values(u.hotbar).includes(macroId)
    );
  }

  static async pushForUser(user) {
    if (!game.user.isGM) return;
    if (!SyncRegistry.isMacroSyncEnabled(user.id)) return;

    const pack = this._getPack();
    if (!pack) return;

    // Build macroId → slots[] from the user's hotbar.
    const macroSlots = new Map();
    for (const [slot, macroId] of Object.entries(user.hotbar)) {
      if (!macroId) continue;
      const slots = macroSlots.get(macroId) ?? [];
      slots.push(Number(slot));
      macroSlots.set(macroId, slots);
    }

    // Load existing compendium entries for this user.
    const compDocs = await pack.getDocuments();
    const userCompDocs = compDocs.filter(d =>
      d.getFlag('omnipresence', 'ownerName') === user.name
    );
    const compByOmpId = new Map(
      userCompDocs.map(d => [d.getFlag('omnipresence', 'id'), d])
    );

    const pushedOmpIds = new Set();

    for (const [macroId, slots] of macroSlots) {
      const macro = game.macros.get(macroId);
      if (!macro) continue;

      // Stamp a stable omnipresence.id on the local doc if it lacks one.
      let ompId = macro.getFlag('omnipresence', 'id');
      if (!ompId) {
        ompId = foundry.utils.randomID(16);
        await macro.update(
          { 'flags.omnipresence.id': ompId },
          { omnipresenceInternal: true }
        );
      }

      const macroData = macro.toObject();
      delete macroData._id;
      delete macroData.folder;
      macroData.flags ??= {};
      macroData.flags.omnipresence = { id: ompId, ownerName: user.name, hotbarSlots: slots };

      const existing = compByOmpId.get(ompId);
      if (existing) {
        await existing.update(macroData);
      } else {
        await Macro.create(macroData, { pack: this.PACK_ID });
      }
      pushedOmpIds.add(ompId);
    }

    // Delete compendium entries for macros no longer on this user's hotbar.
    for (const doc of userCompDocs) {
      if (!pushedOmpIds.has(doc.getFlag('omnipresence', 'id'))) {
        await doc.delete();
      }
    }
  }

  static debouncedPushForUser(user) {
    const id = user.id;
    if (this._timers.has(id)) clearTimeout(this._timers.get(id));
    const timer = setTimeout(() => {
      this._timers.delete(id);
      this.pushForUser(user);
    }, DEBOUNCE_MS);
    this._timers.set(id, timer);
  }

  static handleMacroChange(macro) {
    if (!game.user.isGM) return;
    for (const user of this._getUsersWithMacro(macro.id)) {
      this.debouncedPushForUser(user);
    }
  }

  static handleHotbarChange(user) {
    if (!game.user.isGM) return;
    if (!SyncRegistry.isMacroSyncEnabled(user.id)) return;
    this.debouncedPushForUser(user);
  }

  static async onLogin() {
    // Implemented in Task 5.
  }
}
```

- [ ] **Step 2: Add imports and hooks to `omnipresence.js`**

Add import alongside the other imports at the top:

```javascript
import { MacroSync } from './scripts/macro-sync.js';
```

Replace the existing `ready` hook with:

```javascript
Hooks.once('ready', async () => {
  if (game.user.isGM) {
    const pack = game.packs.get(SyncEngine.PACK_ID);
    if (pack && pack.locked) await pack.configure({ locked: false });
    const macroPack = game.packs.get(MacroSync.PACK_ID);
    if (macroPack && macroPack.locked) await macroPack.configure({ locked: false });
  }
  await SyncEngine.onLogin();
  await MacroSync.onLogin();
});
```

Add these two hooks after the last embedded-doc hook registration block:

```javascript
Hooks.on('updateMacro', (macro, _changes, options, _userId) => {
  if (options?.omnipresenceInternal) return;
  MacroSync.handleMacroChange(macro);
});

Hooks.on('updateUser', (user, changes, options, _userId) => {
  if (options?.omnipresenceInternal) return;
  if (!changes.hotbar) return;
  MacroSync.handleHotbarChange(user);
});
```

- [ ] **Step 3: Copy to module directory**

```bash
cp scripts/macro-sync.js ~/FoundryVTT/Data/Data/modules/omnipresence/scripts/
cp omnipresence.js ~/FoundryVTT/Data/Data/modules/omnipresence/
```

- [ ] **Step 4: Verify hotbar push (Playwright MCP)**

Log into World A as Gamemaster. Create a new Chat macro:
- Name: `Test Roll`
- Type: Chat
- Command: `/roll 1d20+5`

Drag "Test Roll" to hotbar slot 1. Wait 3 seconds (debounce). Run:

```javascript
const docs = await game.packs.get('omnipresence.omnipresence-macros').getDocuments();
return docs.map(d => ({
  name: d.name,
  command: d.command,
  ownerName: d.getFlag('omnipresence', 'ownerName'),
  hotbarSlots: d.getFlag('omnipresence', 'hotbarSlots')
}));
```

Expected:
```json
[{ "name": "Test Roll", "command": "/roll 1d20+5", "ownerName": "Gamemaster", "hotbarSlots": [1] }]
```

- [ ] **Step 5: Verify slot update (Playwright MCP)**

Drag "Test Roll" from slot 1 to slot 3. Wait 3 seconds. Re-run the assertion above.

Expected: `hotbarSlots: [3]`

- [ ] **Step 6: Verify macro content update (Playwright MCP)**

Open the macro editor for "Test Roll", change the command to `/roll 2d6`, save. Wait 3 seconds. Run:

```javascript
const docs = await game.packs.get('omnipresence.omnipresence-macros').getDocuments();
return docs[0]?.command;
```

Expected: `"/roll 2d6"`

- [ ] **Step 7: Verify stale entry deletion (Playwright MCP)**

Right-click slot 3 in the hotbar, clear it (remove "Test Roll" from the bar). Wait 3 seconds. Run:

```javascript
const docs = await game.packs.get('omnipresence.omnipresence-macros').getDocuments();
return docs.length;
```

Expected: `0`

- [ ] **Step 8: Commit**

```bash
git add scripts/macro-sync.js omnipresence.js
git commit -m "feat: push hotbar macros to shared compendium on change"
```

---

### Task 5: MacroSync pull path (onLogin)

**Files:**
- Modify: `scripts/macro-sync.js` (replace the `onLogin()` stub)

**Interfaces:**
- Consumes: `MacroSync.PACK_ID`, `SyncRegistry.isMacroSyncEnabled(userId)` from Tasks 1 + 4

---

- [ ] **Step 1: Implement `MacroSync.onLogin()` in `scripts/macro-sync.js`**

Replace the stub:

```javascript
static async onLogin() {
  // Implemented in Task 5.
}
```

With:

```javascript
static async onLogin() {
  const pack = this._getPack();
  if (!pack) return;
  if (!SyncRegistry.isMacroSyncEnabled(game.user.id)) return;

  const compDocs = await pack.getDocuments();
  const myDocs = compDocs.filter(d =>
    d.getFlag('omnipresence', 'ownerName') === game.user.name
  );
  if (myDocs.length === 0) return;

  // Map existing local macros by stable omnipresence.id.
  const localById = new Map(
    game.macros
      .filter(m => m.getFlag('omnipresence', 'id'))
      .map(m => [m.getFlag('omnipresence', 'id'), m])
  );

  const newHotbarEntries = {};

  for (const compMacro of myDocs) {
    const ompId = compMacro.getFlag('omnipresence', 'id');
    const slots = compMacro.getFlag('omnipresence', 'hotbarSlots') ?? [];

    const macroData = compMacro.toObject();
    delete macroData._id;   // let Foundry assign a fresh world-local _id
    delete macroData.folder;

    let localMacro = localById.get(ompId);
    try {
      if (localMacro) {
        await localMacro.update(macroData, { omnipresenceInternal: true });
      } else {
        localMacro = await Macro.create(macroData);
      }
    } catch (err) {
      console.error('Omnipresence | macro pull failed for', compMacro.name, err);
      continue;
    }

    for (const slot of slots) {
      newHotbarEntries[slot] = localMacro.id;
    }
  }

  if (Object.keys(newHotbarEntries).length > 0) {
    // Merge; slots not covered by synced macros are left untouched.
    await game.user.update(
      { hotbar: { ...game.user.hotbar, ...newHotbarEntries } },
      { omnipresenceInternal: true }
    );
  }
}
```

- [ ] **Step 2: Copy to module directory**

```bash
cp scripts/macro-sync.js ~/FoundryVTT/Data/Data/modules/omnipresence/scripts/
```

- [ ] **Step 3: Verify cross-world pull (Playwright MCP)**

Precondition: "Test Roll" (`/roll 2d6`) is in the compendium at slot 3 from Task 4.  
First, re-add "Test Roll" to slot 3 in World A if it was cleared in Step 7 of Task 4, wait 3 seconds for push, then proceed.

Log out of World A. Navigate to `http://localhost:30000`, join World B as Gamemaster.

After the `ready` hook fires (page finishes loading), run:

```javascript
const macro = game.macros.find(m => m.getFlag('omnipresence', 'id'));
const hotbar = game.user.hotbar;
return {
  macroName: macro?.name,
  macroCommand: macro?.command,
  slot: Object.entries(hotbar).find(([, id]) => id === macro?.id)?.[0]
};
```

Expected:
```json
{ "macroName": "Test Roll", "macroCommand": "/roll 2d6", "slot": "3" }
```

- [ ] **Step 4: Verify overwrite on pull (Playwright MCP)**

In World B: open the "Test Roll" macro editor, change command to `/roll 3d8`, save (do NOT wait for push — macro sync in World B may or may not push depending on World B's Gamemaster userId, but the point is the compendium still holds `/roll 2d6`).

Log out of World B. Log back into World A. Run:

```javascript
const macro = game.macros.find(m => m.name === 'Test Roll');
return macro?.command;
```

Expected: `"/roll 2d6"` — the compendium version overwrote the World B edit.

- [ ] **Step 5: Verify macro sync pause blocks login pull (Playwright MCP)**

In World A: open User Configuration, uncheck "Synchronize hotbar macros", close.

Update the compendium entry directly (to simulate a change from another world) by running:

```javascript
const docs = await game.packs.get('omnipresence.omnipresence-macros').getDocuments();
await docs[0]?.update({ command: '/roll 4d4' });
return docs[0]?.command;
```

Expected: `"/roll 4d4"` (compendium updated).

Log out and back into World A. Run:

```javascript
return game.macros.find(m => m.name === 'Test Roll')?.command;
```

Expected: `"/roll 2d6"` — pull was skipped because macro sync is paused.

Re-check "Synchronize hotbar macros" in User Configuration.

- [ ] **Step 6: Manual check — script macro survives round-trip**

In World A: create a Script macro (Type: Script, Name: `My Script`, Command: `console.log("hello")`). Drag to slot 2. Wait 3 seconds. Log into World B. Verify the macro appears in slot 2 with the same command. Attempting to execute it may log to the console or silently succeed — that is expected. The point is the content is faithfully carried.

- [ ] **Step 7: Manual check — multi-page hotbar**

In World A: drag a macro to slot 11 (page 2, slot 1). Wait 3 seconds. Log into World B. Verify the macro appears in slot 11. Run `game.user.hotbar` in the console and confirm key `"11"` is populated.

- [ ] **Step 8: Commit**

```bash
git add scripts/macro-sync.js
git commit -m "feat: pull hotbar macros from compendium on world login"
```
