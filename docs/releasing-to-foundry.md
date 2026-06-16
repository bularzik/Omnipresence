# Listing & releasing Omnipresence on Foundry VTT

This module is installable today via its manifest URL. To make it
**discoverable in Foundry's in-app package browser**, it must be registered
and approved on foundryvtt.com. Do the one-time steps below; after that, every
`v*` tag auto-publishes via `.github/workflows/release.yml`.

## One-time registration (manual)

1. **Check the package id `omnipresence` is available on the registry FIRST.**
   The id is referenced throughout the code (`flags.omnipresence`,
   `PACK_ID = omnipresence.omnipresence-<system>`, the `omnipresence.*` world
   settings, and `module.json` `id`). If it is taken, registration forces a
   rename that ripples through all of those — resolve before going further.
2. Sign in at https://foundryvtt.com with a Foundry account.
3. Submit a new package. For the manifest, use a version-pinned release
   manifest, e.g.
   `https://github.com/bularzik/Omnipresence/releases/download/v0.1.0/module.json`.
   Fill in title, description, and project URL.
4. Wait for Foundry staff approval (external; typically days). The release
   workflow no-ops until the token below exists, so tagging keeps working.
5. After approval, open the package edit page, copy the **Package Release
   Token** (`fvttp_...`), and add it to the GitHub repo as an Actions secret
   named `FOUNDRY_RELEASE_TOKEN`
   (Settings → Secrets and variables → Actions → New repository secret).

## Per-release (automated)

Use the `/publish` skill to tag a new version. Pushing the `v*` tag runs
`.github/workflows/release.yml`, which builds the GitHub Release and POSTs to
the Foundry Release API. Confirm the new version appears on the package page.

## Manually validating a publish (dry run)

To test the API call without saving, add `"dry-run": true` at the top level of
the JSON body and POST it yourself:

```bash
curl -sS -X POST 'https://foundryvtt.com/_api/packages/release_version/' \
  -H 'Content-Type: application/json' \
  -H "Authorization: $FOUNDRY_RELEASE_TOKEN" \
  -d '{"id":"omnipresence","dry-run":true,"release":{"version":"0.1.0","manifest":"https://github.com/bularzik/Omnipresence/releases/download/v0.1.0/module.json","compatibility":{"minimum":"13","verified":"13"}}}'
```

---
