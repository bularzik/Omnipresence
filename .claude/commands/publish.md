# Publish

Bump the module version and trigger a GitHub release by pushing a git tag.

## Usage
/publish [major|minor|patch]

If no argument is given, default to `patch`.
If an unrecognized argument is given (not `major`, `minor`, or `patch`), default to `patch` and inform the user.

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
   If the push fails, clean up the local tag to avoid a dangling ref:
   ```bash
   git tag -d v{new_version}
   ```
   Then report the error to the user.

6. Confirm the tag was pushed and tell the user the GitHub Actions workflow will now run to build and publish the release. The release will appear at: https://github.com/bularzik/Omnipresence/releases
