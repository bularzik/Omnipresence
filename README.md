# Omnipresence

A Foundry VTT module that synchronizes player character actors, journals, and hotbar macros across multiple worlds on the same server.

## Overview

Foundry VTT allows you to manually share documents between worlds by saving them to a compendium and importing them elsewhere. Omnipresence automates this: enroll a character or journal once, and it stays in sync across every world you play in — automatically updated on login and whenever it is edited. Your hotbar macros follow you too, so your action bar looks the same no matter which world you join. Links between synced documents are rewritten automatically, so a journal's link to your character (or to another journal) keeps working in every world.

## Requirements

- Foundry VTT v13 or higher
- Multiple worlds on the same Foundry server

## Installation

1. Copy the `omnipresence/` folder into your Foundry `Data/modules/` directory.
2. Launch Foundry and open a world.
3. Go to **Add-on Modules** and enable **Omnipresence**.
4. Reload the world.

## How It Works

Omnipresence uses shared compendium packs (per-system character packs, plus `Omnipresence — Journals` and a macros pack) as the single source of truth. All worlds with the module active read and write to the same pack files on disk.

Each enrolled document is stamped with a stable id (`flags.omnipresence.id`) so it can be recognized across worlds even if renamed. That same id doubles as the world-independent form links are stored in, which is how cross-world links resolve.

### Enrolling a character

Right-click any actor in the **Actors Directory** and choose **Add to Omnipresence Sync**. This option is visible to the actor's owner and to the GM. The actor is immediately pushed to the shared compendium.

> **Note for players:** If no GM is connected when you enroll, the actor is marked for sync but the upload happens the next time a GM joins. You'll see a "marked for sync" confirmation rather than an immediate upload notice.

To stop syncing, right-click and choose **Remove from Omnipresence Sync**. The actor remains in both the world and the compendium — it simply stops being tracked.

### Automatic sync

- **On login:** Each of your enrolled characters is compared against the shared compendium. If the shared version is newer, it is pulled silently. If any characters have changed on both sides, they are surfaced together in a single dialog (see [Conflict Resolution](#conflict-resolution)) — not one prompt per character. Your hotbar macros are also pulled from the shared compendium and placed in the correct slots automatically.
- **On edit:** Any change to an enrolled actor — including inventory, spells, features, and active effects — is pushed to the compendium within 2 seconds. Editing a macro or moving it on your hotbar triggers the same 2-second push.
- **On logout:** Edits made in the last couple of seconds before you leave are not pushed immediately, but the change is remembered and synced automatically the next time you log in.

### Hotbar macro sync

All macros on your hotbar — both Chat and Script types — are kept in sync across worlds. When you log into a new world, your macros are automatically created there and placed in the correct hotbar slots. Removing a macro from your hotbar removes it from the shared store; adding one pushes it within 2 seconds.

Each user's macros are stored independently, so two players can have completely different hotbars without interfering with each other.

### Journal sync

Journals sync the same way characters do. Right-click a journal in the **Journal Entries** directory and choose **Add to Omnipresence Sync** — available to the journal's owner and to the GM. Enrolled journals are pushed on edit (including page additions, renames, and deletions, which are matched by stable page ids), pulled on login, and auto-imported into worlds where they don't exist yet, owned by the same player.

Journals from modules that define custom page types — such as **Campaign Record** or **Monk's Enhanced Journal** — sync faithfully: page types, data, and module flags travel verbatim. If a world is missing a module a synced journal depends on, you get a single notification at login listing what's needed (Foundry preserves the data untouched in the meantime). Media paths that point inside a specific world's folder are flagged the same way.

### Cross-world links

Links between synced documents keep working in every world. When an enrolled journal or actor references another enrolled document — an `@UUID` link in page text or a character bio, or structured references like Campaign Record's NPC-to-actor relation and Monk's Enhanced Journal relationships — Omnipresence rewrites the link to each world's local copy on sync. If a link's target hasn't reached a world yet, the link stays dormant and is healed automatically at a later login once the target arrives.

Links to documents that aren't enrolled (a world's scenes, unsynced actors) are left untouched — they keep working in their home world and are simply dead elsewhere.

### New worlds

When you log into a world where one of your characters or journals doesn't exist yet, Omnipresence creates it automatically from the compendium, assigns you ownership, and enrolls it in sync. Hotbar macros are created the same way — you don't need to set up your action bar again.

## Settings Dashboard

Open **Configure Settings → Module Settings → Manage Sync** to view and manage synced documents. Enrolled actors and journals appear in separate tables with the same controls.

**GMs** see all enrolled actors and journals across all users with controls to:
- Force push (overwrite compendium with local version)
- Force pull (overwrite local with compendium version)
- Remove from sync
- Force sync all enrolled documents at once

**Players** see only their own documents, with controls to force pull (overwrite the local copy with the shared version) or remove from sync. Players cannot force push — only a GM can write to the shared compendium.

## Per-User Sync Preferences

Click your username in the top-right corner of any world to open **User Configuration**. An **Omnipresence** section lets you toggle each sync feature independently:

- **Synchronize player characters across worlds** — when off, actor sync is paused entirely: enrolled actors are not pushed or pulled, and the enroll/unenroll context menu items are hidden.
- **Synchronize hotbar macros across worlds** — when off, macros are neither pushed on edit nor pulled on login.
- **Synchronize journals across worlds** — when off, journal sync is paused the same way: no pushes, pulls, or journal context menu items.

Preferences are saved immediately on change and persist per-world.

## Conflict Resolution

A conflict occurs when the same document has been modified both locally and in the shared compendium since the last sync. This can happen when a character or journal is edited in two different worlds between logins.

When conflicts are detected on login, all of your conflicting documents — actors and journals together — are shown in a single **Resolve Sync Conflicts** dialog, one row per document, each showing when you last edited it locally and when the shared copy was last updated. Resolve each from its row:

- **Use shared** (force pull) overwrites your local copy with the shared version.
- **Remove from sync** stops tracking that character.

The dialog closes automatically once every conflict is resolved. Characters you leave unresolved are untouched and surface again on your next login.

Because only a GM can write to the shared compendium, players resolve conflicts by pulling the shared version. A GM additionally has a **force push** option to make a local copy the new master.

## Notes

- Same-server only. Cross-server sync is not supported in this version.
- System-agnostic. Full documents are synced without interpreting system-specific data, so Omnipresence works with any supported game system; journals use a single system-agnostic pack.
- Deleting an enrolled actor or journal from a world removes it from that world's sync registry but leaves the compendium entry intact. The next time you log into any world, the document is automatically re-imported.
- Cross-world links only work between enrolled documents. Scenes are not
  synced, so scene links stay world-local.
- **Map pins travel with their journal.** A synced journal's map pins are
  mirrored onto scenes with the **same name** in other worlds (created, moved,
  and deleted to match), applied at GM login. Rename a scene and its pins stop
  syncing for it — nothing is deleted, they simply stop matching.
- Macro sync is all-or-nothing per user — there is no per-macro opt-in. If you want a macro local-only, keep it off your hotbar.
- Sync preferences are world-scoped. A preference set in World A does not carry to World B automatically, since user IDs differ between worlds.
