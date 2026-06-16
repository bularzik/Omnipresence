# Design: Listing Omnipresence in the Foundry VTT package browser

**Date:** 2026-06-16
**Status:** Approved (pending spec review)

## Goal

Make Omnipresence discoverable and installable from *inside* Foundry's setup
screen (the in-app package browser), instead of only installable by pasting a
manifest URL. As a follow-on, automate per-version publishing to Foundry so
each `v*` tag both creates a GitHub Release (already works) and notifies the
Foundry registry.

## Background: how Foundry distribution actually works

The module is already installable today via its manifest URL
(`https://github.com/bularzik/Omnipresence/releases/latest/download/module.json`).
Discovery in the in-app browser is a separate thing and requires registering
the package with Foundry's official registry at foundryvtt.com.

Three facts from Foundry's docs drive this design:

1. **Discovery = registration + manual approval.** A new package is submitted at
   foundryvtt.com and reviewed by Foundry staff before it is publicly listed.
   Their docs: *"After your submitted package is approved, you'll get access to
   a Package Management site."* This human gate cannot be automated or skipped.
2. **Versions are published via the Release API** —
   `POST https://foundryvtt.com/_api/packages/release_version/` with a release
   token (Authorization header), the package `id`, the `version`, the
   `compatibility` block, and a **version-pinned** manifest URL. Foundry's docs
   require this URL to "point to a specific release," i.e. *not* the `/latest/`
   URL.
3. **Canonical URL split** (community convention + Foundry update mechanics):
   - `module.json` `manifest` field → `/latest/` URL, so Foundry's
     check-for-updates works.
   - `module.json` `download` field → version-pinned to the tag, so installing
     a given version reliably fetches that version's zip.

The current `release.yml` sets `download` to a `/latest/` URL, which is the one
thing that needs correcting.

## Scope

**In scope**

- A one-time manual runbook to register and get the package approved.
- Changes to `.github/workflows/release.yml`:
  - Fix the `module.json` patch so `download` is version-pinned (keep
    `manifest` on `/latest/`).
  - Add a step that publishes each release to Foundry's Release API.

**Out of scope**

- The manual manifest-URL install path (already works; unchanged).
- Any module *code* changes (`scripts/`, `omnipresence.js`, etc.).
- Paid/premium content or the Content Creator program (this is a free module;
  it only needs standard approval).

## Part A — One-time registration runbook (manual, no code)

1. **Verify the package `id` `omnipresence` is available on the registry FIRST.**
   This is the one material risk. The id is referenced pervasively (flag
   namespace `flags.omnipresence`, `PACK_ID = omnipresence.omnipresence-<system>`,
   the `omnipresence.*` world settings, `module.json` `id`). If the id is already
   taken, registration forces a rename that ripples through all of those. Confirm
   availability before investing further.
2. Create / sign in to a foundryvtt.com account.
3. Submit a new package. Point the submission's manifest at the existing
   version-pinned release manifest
   (`https://github.com/bularzik/Omnipresence/releases/download/v0.1.0/module.json`).
   Provide title, description, and project URL.
4. Wait for Foundry staff approval. This is an external dependency measured in
   days; nothing in this repo unblocks it.
5. After approval, open the package's edit page, copy the **Package Release
   Token**, and store it as a GitHub Actions repository secret named
   `FOUNDRY_RELEASE_TOKEN`.

## Part B — Workflow automation (`.github/workflows/release.yml`)

### B1. Correct the manifest patch

In the existing "Patch module.json" step:

- `version` → from the tag (unchanged).
- `manifest` → `.../releases/latest/download/module.json` (unchanged; stays
  `/latest/` for update checks).
- `download` → **change** to the version-pinned URL
  `https://github.com/bularzik/Omnipresence/releases/download/${GITHUB_REF_NAME}/omnipresence.zip`.

### B2. Publish to the Foundry Release API

Add a step *after* the "Create GitHub Release" step (so the version-pinned
manifest asset URL resolves before Foundry fetches it). The step:

- Runs only when the `FOUNDRY_RELEASE_TOKEN` secret is present, so tagging still
  works before approval and the workflow never hard-fails on a missing token.
- Reads `id` and the `compatibility` block (`minimum`, `verified`, optional
  `maximum`) from `module.json`.
- `POST`s to `https://foundryvtt.com/_api/packages/release_version/` with the
  token as the `Authorization` header and a JSON body containing: `id`,
  `release` = { `version`, `manifest` (version-pinned:
  `.../releases/download/${GITHUB_REF_NAME}/module.json`), `compatibility`,
  optional `notes` }.
- Implemented as an inline `curl` + `jq` step (no third-party action), matching
  this repo's plain/no-build/minimal-deps ethos and the existing `jq` usage in
  the workflow. The community "FoundryVTT publish package action" is the
  considered alternative but rejected to avoid a third-party dependency in the
  release pipeline for a ~10-line API call.

## Risks & dependencies

- **`id` collision (primary risk):** check availability before registering;
  a rename is expensive. See Part A step 1.
- **Approval latency:** out of our control; Part B is built to no-op until the
  token secret exists, so releases keep working in the meantime.
- **API/asset-timing:** the publish step must run after the release assets are
  uploaded, or Foundry's fetch of the version-pinned manifest 404s. Ordering in
  B2 handles this.

## Verification

- `npm test` is unaffected (no code change) but run it to confirm green.
- Dry-run the workflow logic by tagging a throwaway prerelease, or by manually
  running the `curl` body against the API once the token exists, and confirm
  Foundry shows the new version. The publish step's secret-gating means the
  workflow can be merged and exercised on a real tag without breaking if
  approval hasn't landed yet.
