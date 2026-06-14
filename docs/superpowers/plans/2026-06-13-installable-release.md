# Installable Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Omnipresence installable through Foundry's setup pages via GitHub Releases, with a `/publish` slash command to trigger releases.

**Architecture:** Add `manifest`/`download`/`url` fields to `module.json`; a GitHub Actions workflow patches the version from the tag, zips runtime files, and publishes a GitHub Release; a `.claude/commands/publish.md` slash command handles version bumping and tag pushing.

**Tech Stack:** GitHub Actions, `jq` (built into ubuntu-latest), `softprops/action-gh-release@v2`, Claude Code slash commands

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `module.json` | Modify | Add `manifest`, `download`, `url` fields |
| `.github/workflows/release.yml` | Create | Tag-triggered release automation |
| `.claude/commands/publish.md` | Create | `/publish` slash command |

---

### Task 1: Add manifest fields to `module.json`

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Add the three fields**

Open `module.json`. After the existing `"compatibility"` block, add:

```json
  "manifest": "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json",
  "download": "https://github.com/bularzik/Omnipresence/releases/latest/download/omnipresence.zip",
  "url": "https://github.com/bularzik/Omnipresence",
```

The final `module.json` should look like:

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
  "manifest": "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json",
  "download": "https://github.com/bularzik/Omnipresence/releases/latest/download/omnipresence.zip",
  "url": "https://github.com/bularzik/Omnipresence",
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
      "type": "Actor"
    }
  ]
}
```

- [ ] **Step 2: Verify valid JSON**

```bash
jq . module.json
```

Expected: full JSON printed with no errors. If `jq` errors, fix the syntax before continuing.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "feat: add manifest, download, and url fields for Foundry installation"
```

---

### Task 2: Create the GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Write the workflow file**

Create `.github/workflows/release.yml` with this exact content:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - name: Extract version
        id: version
        run: echo "VERSION=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Patch module.json
        run: |
          jq \
            --arg v "${{ steps.version.outputs.VERSION }}" \
            --arg m "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json" \
            --arg d "https://github.com/bularzik/Omnipresence/releases/latest/download/omnipresence.zip" \
            '.version = $v | .manifest = $m | .download = $d' \
            module.json > module.patched.json
          mv module.patched.json module.json

      - name: Create zip
        run: |
          zip -r omnipresence.zip \
            module.json \
            omnipresence.js \
            scripts/ \
            styles/ \
            templates/ \
            lang/ \
            packs/

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            omnipresence.zip
            module.json
```

- [ ] **Step 3: Verify the jq patch command locally**

Run this to confirm jq produces the expected output (substitute `1.0.1` as a test version):

```bash
jq \
  --arg v "1.0.1" \
  --arg m "https://github.com/bularzik/Omnipresence/releases/latest/download/module.json" \
  --arg d "https://github.com/bularzik/Omnipresence/releases/latest/download/omnipresence.zip" \
  '.version = $v | .manifest = $m | .download = $d' \
  module.json
```

Expected: JSON printed to stdout with `"version": "1.0.1"`, `"manifest": "https://..."`, `"download": "https://..."`. No file is modified by this check — it just prints.

- [ ] **Step 4: Verify YAML syntax**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"
```

Expected: `YAML OK`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add GitHub Actions release workflow"
```

---

### Task 3: Create the `/publish` slash command

**Files:**
- Create: `.claude/commands/publish.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p .claude/commands
```

- [ ] **Step 2: Write the command file**

Create `.claude/commands/publish.md` with this content:

```markdown
# Publish

Bump the module version and trigger a GitHub release by pushing a git tag.

## Usage
/publish [major|minor|patch]

If no argument is given, default to `patch`.

## Steps

1. Get the current version from the latest git tag:
   ```bash
   git tag --sort=-v:refname | head -1
   ```
   If the output is empty (no tags exist), treat the current version as `0.0.0`.

2. Strip the leading `v` from the tag. Split the result on `.` into three integers: `major`, `minor`, `patch`.

3. Apply the bump rule based on the argument:
   - `major` → new version is `{major+1}.0.0`
   - `minor` → new version is `{major}.{minor+1}.0`
   - `patch` (default) → new version is `{major}.{minor}.{patch+1}`

4. Show the user the computed tag and ask for confirmation before pushing:
   > "Ready to push tag `v{new_version}` and trigger a release? This will publish a public GitHub release."

5. On confirmation, run:
   ```bash
   git tag v{new_version}
   git push origin v{new_version}
   ```

6. Confirm the tag was pushed and tell the user the GitHub Actions workflow will now run to build and publish the release. The release will appear at: https://github.com/bularzik/Omnipresence/releases
```

- [ ] **Step 3: Verify the command is discoverable**

```bash
ls .claude/commands/publish.md
```

Expected: file listed with no error.

- [ ] **Step 4: Commit**

```bash
git add .claude/commands/publish.md
git commit -m "feat: add /publish slash command for version bumping and release tagging"
```

---

### Task 4: Smoke-test the full release flow

- [ ] **Step 1: Run `/publish` to trigger the first release**

Invoke `/publish` (defaults to patch bump from `0.0.0` → `v1.0.0`, or from whatever the current latest tag is). Confirm when prompted.

- [ ] **Step 2: Verify the tag was pushed**

```bash
git tag --sort=-v:refname | head -1
```

Expected: `v1.0.0` (or whatever was computed).

- [ ] **Step 3: Watch the Actions run**

Go to `https://github.com/bularzik/Omnipresence/actions` and confirm the `Release` workflow triggered and completed successfully. All four steps (checkout, extract version, patch module.json, create release) should show green.

- [ ] **Step 4: Verify release assets**

Go to `https://github.com/bularzik/Omnipresence/releases` and confirm:
- A release exists for the tag
- Two assets are attached: `omnipresence.zip` and `module.json`
- Download `module.json` and confirm it contains the correct `version`, `manifest`, and `download` fields

- [ ] **Step 5: Verify the module installs in Foundry**

In Foundry's **Setup → Add-on Modules → Install Module** dialog, paste:

```
https://github.com/bularzik/Omnipresence/releases/latest/download/module.json
```

Click Install. Confirm the module appears in the installed modules list with the correct version.
