# Changelog

All notable changes to Omnipresence are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Git tags (`v*`) are the source of truth for released versions — the committed
> `module.json` `version` intentionally lags and is patched at release time by
> the CI workflow.

## [Unreleased]

### Fixed
- Journal pulls no longer carry spurious page updates caused by server-managed
  `_stats` differences between worlds.
- One bad compendium copy can no longer abort login sync: auto-import isolates
  per-document failures (actors and journals), and a malformed map-pin payload
  is tolerated instead of throwing.
- Quoted UUID strings in macro commands (e.g. `fromUuid('JournalEntry.…')`)
  now participate in cross-world link rewriting.

## [0.4.0] - 2026-07-16

### Added
- **Map-pin sync.** An enrolled journal's map pins (scene notes) now travel
  with it: captured on push, and mirrored — created, moved, deleted — onto
  same-named scenes in other worlds at GM login. Scenes themselves stay
  world-local; worlds without a matching scene skip the pins and heal at a
  later login once the scene exists.

### Fixed
- Hotbar macros now participate in cross-world link rewriting: document links
  inside a macro's command are canonicalized on push and localized on pull,
  like actors and journals.
- Deletions now propagate across worlds: push/pull write complete snapshots
  with subtree replacement instead of recursive merge, so a flag entry or
  module-data key removed in one world (e.g. a deleted Monk's Enhanced
  Journal relationship) no longer resurrects in others.
- Pending debounced pushes are cancelled when the page unloads (world switch,
  tab close), so no partial compendium write can fire into the shutdown
  window. The unsent edit is dirty-marked and syncs at the next login.

## [0.3.0] - 2026-07-15

### Added
- **Journal synchronization (Increment 1).** Enrolled `JournalEntry` documents
  now sync across worlds, mirroring actor sync: owner-aware enrollment and
  auto-import to the matching player, a single system-agnostic compendium pack
  (`omnipresence-journals`), and reconciliation of embedded `JournalEntryPage`
  documents by stable `_id`.
- Journal enroll/unenroll entries in the Journal directory context menu.
- A **Sync Journals** toggle in the User Configuration dialog (per-user opt-in,
  alongside the existing PC and Hotbar toggles).
- A **Journals** table in the GM dashboard with Force Push / Force Pull / Remove,
  and journal conflicts surfaced in the login conflicts-only view.
- Lossless "subclass" fidelity: custom page subtypes (e.g. Campaign Record's
  `campaign-record.npc`) and module flags (e.g. Monk's Enhanced Journal) travel
  verbatim, and a single per-login notification lists any modules a world is
  missing for full fidelity (plus world-local media paths).
- Pure, unit-tested helpers `resolveOwningJournal`, `requiredModulesForJournal`,
  and `worldLocalMediaPaths` in `sync-logic.js`.
- **Cross-world link rewriting (Journal sync Increment 2).** Links to enrolled
  actors and journals — `@UUID[…]` enrichers, legacy `@Actor[…]`-style
  enrichers, `data-uuid` attributes, and UUID-valued data fields (e.g.
  Campaign Record relations) — now resolve in every world. The shared
  compendium stores canonical omnipresence ids (valid document ids, so
  schema-validated fields like Campaign Record's relations accept them); each
  world localizes them on pull/import, and a login heal pass resolves links
  whose targets arrived later. Includes a Monk's Enhanced Journal adapter for
  its bare-id relationship storage. Links to non-enrolled documents are left
  untouched.

### Changed
- Actor and journal conflicts detected at login are now surfaced in a **single**
  consolidated conflicts-only dashboard instead of one window per document type.
  `SyncEngine.onLogin()` and `JournalSync.onLogin()` return their conflict ids;
  the `ready` hook opens one dashboard carrying both.

### Fixed
- Change hooks now ignore compendium documents. Our own pack writes fire the
  same `update*`/`delete*`/page hooks as world docs, so a GM push previously
  fed back on itself: the pack copy was marked dirty and re-pushed onto itself
  every 2s, resurrecting stale cached state, wiping `ownerName` (pack copies
  carry no ownership), and — via the delete hooks — unenrolling a world doc
  when its pack copy was deleted. All handlers now bail on `doc.pack`.

- Non-GM users who own a document can now enroll it in sync. Enrollment is
  tracked by an owner-writable `flags.omnipresence.enrolled` flag instead of a
  GM-only world setting, which previously threw a permission error for players.
  The legacy world registry is still honored for already-enrolled documents, so
  no migration is required. (Fixes actor enrollment for non-GMs too.)

- `ownerName` is now re-stamped from current ownership on every push (actors and
  journals), so the shared compendium copy no longer goes stale when ownership is
  granted after enrollment. A missing/stale `ownerName` had caused GM auto-import
  into other worlds to silently skip the document.

- Macro pull no longer fails for non-GM users. The GM-only `author` and
  `ownership` fields are now stripped before a synced macro is written locally
  (via a new pure `stripMacroLocalFields` helper), so a player's login-time macro
  pull no longer throws `The "ownership"/"author" field may only be modified by a
  GM` and silently skips the macro.

### Notes
- The cross-world UUID link-rewriting engine (making journal→journal and
  journal→actor links resolve across worlds) is planned as Increment 2 and is
  not part of this release.

## [0.2.4] - 2026-06-30

### Added
- GM login batch-pushes every user's hotbar to catch up macro changes made while
  the GM was offline.

### Fixed
- Per-user push errors are isolated in the GM `onLogin` batch push so one user's
  failure no longer aborts the rest.

## [0.2.3] - 2026-06-30

### Fixed
- Per-user sync preferences are stored in User flags instead of a world-scoped
  setting (lets each user write their own prefs without GM permission).
- Re-read preferences in `setTimeout(0)` to survive `renderUserConfig`
  re-render races.

## [0.2.2] - 2026-06-29

### Fixed
- Non-GM preference writes are proxied through a GM socket to resolve a
  permission error.

## [0.2.1] - 2026-06-29

### Fixed
- User Config Omnipresence toggles: shorter labels with hint text, native
  form-group markup, and injection into the inner content div rather than the
  outer form.

## [0.2.0] - 2026-06-29

### Added
- **Hotbar macro synchronization** across worlds via a shared `omnipresence-macros`
  pack: push on change, pull on world login, with world-local ownership stripped.
- Omnipresence sync toggles (PCs, Hotbar) injected into the User Configuration
  dialog, respected across hooks, `onLogin`, and the context menu.

### Fixed
- Non-GM enroll shows a "queued for sync" message.

### CI
- Publish each release to the Foundry package registry; version-pin the download
  URL; harden the publish step against malformed `module.json`.

## [0.1.0] - 2026-06-15

### Added
- **Batch login conflict resolution:** a single conflicts-only dashboard opens at
  login (replacing per-actor modals) and auto-closes when all conflicts resolve.
- Authoritative conflict badge with enriched timestamps; force-push/force-pull
  exposed on player rows (players can only force-pull — the compendium is
  GM-write).
- Pure `deriveConflictState` helper for the dashboard badge.

### Fixed
- Dashboard actions bound to handler functions (ApplicationV2 requirement).
- Force Sync All hidden in the conflicts-only view.

## [0.0.3] - 2026-06-14

### Added
- **Embedded-data sync:** reconcile items, effects, and effects nested on items
  on push/pull (`keepId` on creates, `_id`-keyed diffing).
- Sync triggered by embedded item/effect changes via the owning actor.
- Pure helpers `diffEmbedded` and `resolveOwningActor`.

### Fixed
- Bind the actor context menu to the v13 `getActorContextOptions` hook.
- Drop the `beforeunload` compendium flush that raced world shutdown.

## [0.0.2] - 2026-06-14

### Added
- Per-system `Actor` compendium packs declared in `module.json`.
- Pure `decideSyncAction` and `stripWorldLocalFields` helpers.
- Unsupported-system notification.

### Fixed
- GM-only compendium writes with a dynamic, per-system pack id.
- v13 `data-entry-id` resolution and native `HTMLElement` tolerance in the
  context menu.

## [0.0.1] - 2026-06-13

### Added
- Initial cross-world actor synchronization: context-menu enroll/unenroll,
  debounced GM compendium push on actor update, login pull/push/auto-import,
  and an ApplicationV2 GM/player dashboard.
- `/publish` slash command and a GitHub Actions release workflow (manifest,
  download, and url fields for Foundry installation).

[Unreleased]: https://github.com/bularzik/Omnipresence/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/bularzik/Omnipresence/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/bularzik/Omnipresence/compare/v0.2.4...v0.3.0
[0.2.4]: https://github.com/bularzik/Omnipresence/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/bularzik/Omnipresence/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/bularzik/Omnipresence/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/bularzik/Omnipresence/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bularzik/Omnipresence/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bularzik/Omnipresence/compare/v0.0.3...v0.1.0
[0.0.3]: https://github.com/bularzik/Omnipresence/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/bularzik/Omnipresence/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/bularzik/Omnipresence/releases/tag/v0.0.1
