# Omnipresence

A Foundry VTT module that synchronizes player character actors across multiple worlds on the same server.

## Overview

Foundry VTT allows you to manually share actors between worlds by saving them to a compendium and importing them elsewhere. Omnipresence automates this: enroll a character once, and it stays in sync across every world you play in — automatically updated on login and whenever the character is edited.

## Requirements

- Foundry VTT v13 or higher
- Multiple worlds on the same Foundry server

## Installation

1. Copy the `omnipresence/` folder into your Foundry `Data/modules/` directory.
2. Launch Foundry and open a world.
3. Go to **Add-on Modules** and enable **Omnipresence**.
4. Reload the world.

## How It Works

Omnipresence uses a shared compendium pack (`Omnipresence Shared Characters`) as the single source of truth. All worlds with the module active read and write to the same pack files on disk.

Each enrolled actor is stamped with a stable UUID (`flags.omnipresence.id`) so it can be recognized across worlds even if renamed.

### Enrolling a character

Right-click any actor in the **Actors Directory** and choose **Add to Omnipresence Sync**. This option is visible to the actor's owner and to the GM. The actor is immediately pushed to the shared compendium.

To stop syncing, right-click and choose **Remove from Omnipresence Sync**. The actor remains in both the world and the compendium — it simply stops being tracked.

### Automatic sync

- **On login:** Each of your enrolled characters is compared against the shared compendium. If the shared version is newer, it is pulled silently. If any characters have changed on both sides, they are surfaced together in a single dialog (see [Conflict Resolution](#conflict-resolution)) — not one prompt per character.
- **On edit:** Any change to an enrolled actor — including inventory, spells, features, and active effects — is pushed to the compendium within 2 seconds.
- **On logout:** Edits made in the last couple of seconds before you leave are not pushed immediately, but the change is remembered and synced automatically the next time you log in.

### New worlds

When you log into a world where one of your characters doesn't exist yet, Omnipresence creates it automatically from the compendium, assigns you ownership, and enrolls it in sync.

## Settings Dashboard

Open **Configure Settings → Module Settings → Manage Sync** to view and manage synced actors.

**GMs** see all enrolled actors across all users with controls to:
- Force push (overwrite compendium with local version)
- Force pull (overwrite local with compendium version)
- Remove from sync
- Force sync all enrolled actors at once

**Players** see only their own actors, with controls to force pull (overwrite the local copy with the shared version) or remove from sync. Players cannot force push — only a GM can write to the shared compendium.

## Conflict Resolution

A conflict occurs when the same actor has been modified both locally and in the shared compendium since the last sync. This can happen when a character is edited in two different worlds between logins.

When conflicts are detected on login, all of your conflicting characters are shown together in a single **Resolve Sync Conflicts** dialog — one row per character, each showing when you last edited it locally and when the shared copy was last updated. Resolve each from its row:

- **Use shared** (force pull) overwrites your local copy with the shared version.
- **Remove from sync** stops tracking that character.

The dialog closes automatically once every conflict is resolved. Characters you leave unresolved are untouched and surface again on your next login.

Because only a GM can write to the shared compendium, players resolve conflicts by pulling the shared version. A GM additionally has a **force push** option to make a local copy the new master.

## Notes

- Same-server only. Cross-server sync is not supported in this version.
- System-agnostic. The full actor document is synced without interpreting system-specific data, so Omnipresence works with any game system.
- Deleting an enrolled actor from a world removes it from that world's sync registry but leaves the compendium entry intact. The next time you log into any world, the actor is automatically re-imported.
