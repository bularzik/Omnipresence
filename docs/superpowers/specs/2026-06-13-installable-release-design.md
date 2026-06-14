# Omnipresence — Installable Release Design
_Date: 2026-06-13_

## Overview

Make the Omnipresence Foundry module installable through Foundry's setup pages by hosting releases on GitHub and adding a publish skill for one-command releases.

---

## What Changes

### 1. `module.json` additions

Three fields added to the existing manifest:

```json
"manifest": "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json",
"download": "https://github.com/bularzik/Omnipresence/releases/latest/download/omnipresence.zip",
"url": "https://github.com/bularzik/Omnipresence"
```

- `manifest` — where Foundry fetches the latest manifest to check for updates
- `download` — the zip Foundry installs or updates from
- `url` — homepage link shown in the module browser

The `version` field already exists. The release workflow overwrites it at publish time using the git tag.

---

### 2. GitHub Actions release workflow

File: `.github/workflows/release.yml`

**Trigger:** any tag push matching `v*`

**Steps:**

1. **Extract version** — strips `v` prefix from the tag (`v1.0.1` → `1.0.1`)
2. **Patch `module.json`** — uses `jq` to write `version`, `manifest`, and `download` into the manifest in-place before packaging
3. **Create zip** — explicitly zips runtime files only:
   - `module.json`
   - `omnipresence.js`
   - `scripts/`
   - `styles/`
   - `templates/`
   - `lang/`
   - `packs/`
   - Dev files (`docs/`, `CLAUDE.md`, `AGENTS.md`, `.beads/`, etc.) are excluded by not being named
4. **Publish GitHub Release** — `softprops/action-gh-release@v2` creates a release from the tag and attaches `omnipresence.zip` and `module.json` as assets

**Required permission:** `contents: write`

---

### 3. Publish slash command

File: `.claude/commands/publish.md`

Invoked as `/publish`, `/publish minor`, or `/publish major`.

**Behavior:**

1. Get latest git tag: `git tag --sort=-v:refname | head -1`; fall back to `0.0.0` if no tags exist
2. Strip `v` prefix, split into `[major, minor, patch]`
3. Apply bump rule per argument (default: `patch`):
   - `major` → increment major, reset minor and patch to 0
   - `minor` → increment minor, reset patch to 0
   - `patch` → increment patch only
4. Show computed tag to user and request confirmation
5. On confirmation: `git tag v{version} && git push origin v{version}`

The confirmation step is required because tag pushes trigger a live public release.

---

## Release Trigger Flow

```
/publish [patch|minor|major]
  → compute next version
  → confirm with user
  → git tag + git push
    → GitHub Actions: patch module.json, zip, publish release
      → Foundry users can install/update via manifest URL
```

---

## Installing the Module

Once the first release is published, users paste this URL into Foundry's **Install Module** dialog:

```
https://github.com/bularzik/Omnipresence/releases/latest/download/module.json
```

---

## Files Created or Modified

| File | Change |
|---|---|
| `module.json` | Add `manifest`, `download`, `url` fields |
| `.github/workflows/release.yml` | New — release automation workflow |
| `.claude/commands/publish.md` | New — publish slash command |
