# Foundry Package Listing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Omnipresence discoverable in Foundry's in-app package browser and auto-publish each `v*` release to Foundry's registry.

**Architecture:** A one-time manual registration runbook (committed as docs) gets the package approved and yields a release token stored as a GitHub secret. The existing `release.yml` workflow is then extended to (a) version-pin the `download` URL and (b) POST each release to Foundry's Release API, gated on the token secret so tagging keeps working before approval.

**Tech Stack:** GitHub Actions, `jq`, `curl`, Foundry VTT Package Release API.

---

## File Structure

- `docs/releasing-to-foundry.md` — **Create.** Manual runbook for one-time registration + approval + token setup (spec Part A). Lives in the repo so the human steps are not lost.
- `.github/workflows/release.yml` — **Modify.** Version-pin `download` in the patch step; add the secret-gated Foundry publish step (spec Part B).

No module code changes. `npm test` is unaffected but run at the end as a sanity check.

## Notes on testing approach

This is CI/infra config, not unit-testable application code. "Tests" here are **local validations**: run the workflow's `jq` logic on the command line and assert the output, and use the API's `dry-run` flag to validate the publish payload without saving. There is no Node test for YAML.

---

## Task 1: Version-pin the `download` URL in the patch step

**Files:**
- Modify: `.github/workflows/release.yml` (the "Patch module.json" step)

- [ ] **Step 1: Write the failing validation**

Simulate the current patch logic with a fake tag and assert the intended end state. Run this from the repo root:

```bash
TAG=v9.9.9
jq \
  --arg v "9.9.9" \
  --arg m "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json" \
  --arg d "https://github.com/bularzik/Omnipresence/releases/download/${TAG}/omnipresence.zip" \
  '.version=$v | .manifest=$m | .download=$d' module.json > /tmp/patched.json

# Assertions:
test "$(jq -r '.manifest' /tmp/patched.json)" = "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json" \
  && echo "manifest OK (latest)" || echo "manifest WRONG"
test "$(jq -r '.download' /tmp/patched.json)" = "https://github.com/bularzik/Omnipresence/releases/download/v9.9.9/omnipresence.zip" \
  && echo "download OK (pinned)" || echo "download WRONG"
```

- [ ] **Step 2: Run it against the CURRENT workflow logic to see the gap**

The committed workflow patches `download` to the `/latest/` URL. Reproduce that and confirm it does NOT match the pinned target:

Run:
```bash
jq -r '.download' /tmp/patched.json   # the command above already uses the NEW pinned value
# Now show the OLD behavior the workflow currently ships:
echo "https://github.com/bularzik/Omnipresence/releases/latest/download/omnipresence.zip"
```
Expected: the current workflow's `download` is `.../releases/latest/download/omnipresence.zip` (un-pinned) — this is what we are replacing.

- [ ] **Step 3: Edit the patch step in `release.yml`**

Replace the existing "Patch module.json" step (lines ~20-30) with this. The only functional change is the `$d` value (now tag-pinned) and adding `TAG` to `env`:

```yaml
      - name: Patch module.json
        env:
          VERSION: ${{ steps.version.outputs.VERSION }}
          TAG: ${{ github.ref_name }}
        run: |
          jq \
            --arg v "$VERSION" \
            --arg m "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json" \
            --arg d "https://github.com/bularzik/Omnipresence/releases/download/${TAG}/omnipresence.zip" \
            '.version = $v | .manifest = $m | .download = $d' \
            module.json > module.patched.json
          mv module.patched.json module.json
```

- [ ] **Step 4: Re-run the validation from Step 1**

Run the Step 1 block again.
Expected output:
```
manifest OK (latest)
download OK (pinned)
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: version-pin the download URL in the release manifest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add the secret-gated Foundry publish step

**Files:**
- Modify: `.github/workflows/release.yml` (job-level `env`; new step after "Create GitHub Release")

- [ ] **Step 1: Map the secret to a job-level env var**

Step-level `if:` cannot read the `secrets` context directly, so expose the token as a job env var. Edit the `release:` job header (lines ~9-12) to add `env:`:

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      FOUNDRY_RELEASE_TOKEN: ${{ secrets.FOUNDRY_RELEASE_TOKEN }}
```

- [ ] **Step 2: Add the publish step at the END of the `steps:` list**

Append this after the existing "Create GitHub Release" step. It is the last step in the job. The `if:` gate makes it a clean no-op when the secret is unset (e.g. before Foundry approval):

```yaml
      - name: Publish release to Foundry registry
        if: ${{ env.FOUNDRY_RELEASE_TOKEN != '' }}
        env:
          VERSION: ${{ steps.version.outputs.VERSION }}
          TAG: ${{ github.ref_name }}
        run: |
          payload=$(jq -n \
            --arg id       "$(jq -r '.id' module.json)" \
            --arg version  "$VERSION" \
            --arg manifest "https://github.com/bularzik/Omnipresence/releases/download/${TAG}/module.json" \
            --arg notes    "https://github.com/bularzik/Omnipresence/releases/tag/${TAG}" \
            --arg minimum  "$(jq -r '.compatibility.minimum' module.json)" \
            --arg verified "$(jq -r '.compatibility.verified' module.json)" \
            --arg maximum  "$(jq -r '.compatibility.maximum // ""' module.json)" \
            '{id: $id, release: {version: $version, manifest: $manifest, notes: $notes, compatibility: {minimum: $minimum, verified: $verified, maximum: $maximum}}}')
          echo "Publishing to Foundry:"
          echo "$payload" | jq '.'
          http_code=$(curl -sS -o response.json -w '%{http_code}' \
            -X POST 'https://foundryvtt.com/_api/packages/release_version/' \
            -H 'Content-Type: application/json' \
            -H "Authorization: $FOUNDRY_RELEASE_TOKEN" \
            -d "$payload")
          echo "Foundry API returned HTTP $http_code"
          cat response.json
          if [ "$http_code" -lt 200 ] || [ "$http_code" -ge 300 ]; then
            echo "::error::Foundry publish failed (HTTP $http_code)"
            exit 1
          fi
```

- [ ] **Step 3: Validate the payload builder locally**

Confirm the `jq -n` builder emits the exact shape Foundry expects (run from repo root; uses the committed `module.json` values):

```bash
TAG=v9.9.9
jq -n \
  --arg id       "$(jq -r '.id' module.json)" \
  --arg version  "9.9.9" \
  --arg manifest "https://github.com/bularzik/Omnipresence/releases/download/${TAG}/module.json" \
  --arg notes    "https://github.com/bularzik/Omnipresence/releases/tag/${TAG}" \
  --arg minimum  "$(jq -r '.compatibility.minimum' module.json)" \
  --arg verified "$(jq -r '.compatibility.verified' module.json)" \
  --arg maximum  "$(jq -r '.compatibility.maximum // ""' module.json)" \
  '{id: $id, release: {version: $version, manifest: $manifest, notes: $notes, compatibility: {minimum: $minimum, verified: $verified, maximum: $maximum}}}'
```
Expected output (a well-formed object):
```json
{
  "id": "omnipresence",
  "release": {
    "version": "9.9.9",
    "manifest": "https://github.com/bularzik/Omnipresence/releases/download/v9.9.9/module.json",
    "notes": "https://github.com/bularzik/Omnipresence/releases/tag/v9.9.9",
    "compatibility": {
      "minimum": "13",
      "verified": "13",
      "maximum": ""
    }
  }
}
```

- [ ] **Step 4: Lint the workflow YAML**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"
```
Expected: `YAML OK` (no traceback).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish each release to the Foundry package registry

Secret-gated step POSTs to the Foundry Release API after the GitHub
release is created. No-ops until FOUNDRY_RELEASE_TOKEN is set.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Write the registration runbook (spec Part A)

**Files:**
- Create: `docs/releasing-to-foundry.md`

- [ ] **Step 1: Create the runbook doc**

```markdown
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

\`\`\`bash
curl -sS -X POST 'https://foundryvtt.com/_api/packages/release_version/' \
  -H 'Content-Type: application/json' \
  -H "Authorization: $FOUNDRY_RELEASE_TOKEN" \
  -d '{"id":"omnipresence","dry-run":true,"release":{"version":"0.1.0","manifest":"https://github.com/bularzik/Omnipresence/releases/download/v0.1.0/module.json","compatibility":{"minimum":"13","verified":"13"}}}'
\`\`\`
```

- [ ] **Step 2: Verify the doc renders and links are sane**

Run:
```bash
test -f docs/releasing-to-foundry.md && echo "doc exists"
grep -c "FOUNDRY_RELEASE_TOKEN" docs/releasing-to-foundry.md
```
Expected: `doc exists` and a count `>= 2`.

- [ ] **Step 3: Commit**

```bash
git add docs/releasing-to-foundry.md
git commit -m "docs: runbook for registering & releasing on Foundry VTT

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Final sanity check

- [ ] **Step 1: Run the unit suite (should be untouched)**

Run: `npm test`
Expected: all tests pass (no code changed, this just confirms nothing broke).

- [ ] **Step 2: Confirm the workflow still parses and the diff is what you expect**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"
git --no-pager log --oneline -4
```
Expected: `YAML OK` and the three commits from Tasks 1-3 on the branch.

---

## Self-review checklist (completed during authoring)

- **Spec coverage:** Part A → Task 3 (runbook). Part B1 (pin download) → Task 1.
  Part B2 (publish step) → Task 2. Verification section → Tasks 2-4. No gaps.
- **Placeholders:** none — every step has runnable commands/code and expected output.
- **Consistency:** `FOUNDRY_RELEASE_TOKEN`, `module.json` field paths
  (`.compatibility.minimum/verified/maximum`), and the pinned URL pattern
  `.../releases/download/${TAG}/...` are identical across all tasks and match
  the spec and Foundry's documented API body.
```
