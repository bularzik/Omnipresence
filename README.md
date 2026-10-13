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

The macros on your hotbar that you own — both Chat and Script types — are kept in sync across worlds. A macro the GM shares with everyone without giving you ownership stays in its world. When you log into a new world, your macros are automatically created there and placed in the correct hotbar slots. Removing a macro from your hotbar removes it from the shared store; adding one pushes it within 2 seconds.

Each user's macros are stored independently, so two players can have completely different hotbars without interfering with each other.

**GMs approve script macros.** When a GM logs in and one of their script macros is new to this world, or its code was changed in another world, Omnipresence does not install it silently. A dialog lists each one — name, owner, the world it came from, and its code — with **Install** and **Skip**. The choice is all-or-nothing: Install installs every listed macro and remembers that exact code in this browser, so it is not asked about again; Skip skips them all and you are asked again at your next login. Chat macros, and macros pulled by players (which run with the player's own permissions), install as before.

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

**Players** see only their own documents, with controls to force pull (overwrite the local copy with the shared version) or remove from sync. Players cannot force push — only a GM can write to the shared compendium. When several GMs are connected, only the active GM (Foundry's designated GM) pushes edits automatically; any GM can still Force Push or enroll.

Two or more documents in a world can carry the same sync id (for example a character duplicated after it was enrolled). What happens depends on whether the world has bound that id to a document:
- **The id is bound** (the usual case once the world has recorded its bindings): the bound document, normally the original, keeps syncing. Any other document carrying the id is refused, with a warning in the browser console, every time it would push or pull. It is not listed in the dashboard; remove it from sync, or delete it, if it is a copy you do not need.
- **The id is unbound and its shared copy already exists** (made in this world or in another one): the document is never pulled into or pushed over that copy. The active GM's dashboard lists it under **Duplicate sync ids** together with the shared copy. Such a row is never bound automatically; it stays listed while the document is in sync, and **Remove from Sync** on that document clears it.
- **Several documents carry an unbound id**, which happens if the world upgraded while two documents already shared one id, or if they race to push it for the first time: none of them syncs, and they are listed under **Duplicate sync ids**. Remove the extra copies with **Remove from Sync**. Once only one of them is still in sync, it is bound and syncs again straight away.

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

## What Omnipresence protects

**Synced content is hidden from players in Foundry's interface.** The Omnipresence packs hold GM content from every world on the server, so they are hidden from players and trusted players. If a GM in any world opens one to players in the Compendium sidebar, Omnipresence hides it again at that GM's next login and says why. This matches how Foundry treats GM-only world documents: present on every client, hidden in the UI.

**Reads through the browser console are out of scope.** Foundry does not enforce compendium permissions when a client reads a pack through its API, just as it sends GM-only world documents to every client. A player who uses the browser console can still read pack contents. Keeping GM content secret from such a player would need encryption with a passphrase shared by every GM, which Omnipresence does not do.

**Players sync their own content because of that same behaviour.** A player's client reads its own characters, journals and macros from the hidden packs at login, with no GM online. If a future Foundry version starts enforcing pack permissions on reads, players would stop receiving updates until a GM logs in. The fallback design for that case is to split each pack into a GM-only pack and a player pack.

**No player can change or delete someone else's synced document.** Each world records which of its documents each shared copy belongs to. Only that document can update or delete the copy, and links resolve only to it. A sync id copied onto another document — by hand, by a macro, or by duplicating an enrolled document — is ignored, with a warning in the console. When upgrading, the active GM's first login records this from the world's documents. If two documents already carried the same id, neither syncs until the GM keeps one (see [Settings Dashboard](#settings-dashboard)).

**Macros:** only macros you own sync from your hotbar, a world only removes the shared macro copies it pushed itself, and a GM approves any script macro that is new to a world or was changed elsewhere (see [Hotbar macro sync](#hotbar-macro-sync)).

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
- Documents with no player owner (GM-owned NPCs, GM journals) sync for the GM: they cross into another world once the GM checks them in *Manage synced documents* there. Player-owned documents are gated by their owner's selection, never the GM's.
- Macro sync is all-or-nothing per user — there is no per-macro opt-in. If you want a macro local-only, keep it off your hotbar.
- Sync preferences are world-scoped. A preference set in World A does not carry to World B automatically, since user IDs differ between worlds.
- A document dragged out of an Omnipresence pack by hand is not linked to the shared copy (it carries the id but is not the document that copy belongs to here). Let Omnipresence import it instead, through *Manage synced documents*.
- Deleting or moving out a member of a synced folder when you own neither that member's shared copy nor the folder (for example a journal the GM shares with everyone) removes it only from your world; it comes back at the next login there.

## Development

For running the unit and end-to-end test suites, see [`TESTING.md`](TESTING.md).
