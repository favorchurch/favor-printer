# Releasing Favor Printer

Releases of this repository are the app's download page source and its auto-update feed
(`electron-updater` reads GitHub Releases of `favorchurch/favor-printer`).

**Nothing publishes automatically.** Pushing a tag builds, signs and notarizes the app and uploads it
to a **draft** GitHub release. A maintainer turns the draft into a published release by hand, after an
explicit OK. Until then no volunteer's app can see the release.

## Contents

1. [Versions and channels](#versions-and-channels)
2. [Secrets](#secrets)
3. [Cutting a release](#cutting-a-release)
4. [Publishing the draft](#publishing-the-draft)
5. [Local signing and notarization](#local-signing-and-notarization)
6. [Rollback](#rollback)
7. [What the workflows do](#what-the-workflows-do)

## Versions and channels

The version in `package.json` is the release version. The tag must be `v` plus that exact version. The
release workflow fails when they differ.

| Tag | Channel | GitHub release | Update manifest |
| --- | --- | --- | --- |
| `v1.2.3` | stable | normal release (pre-release flag off, set by the workflow) | `latest-mac.yml` |
| `v1.2.3-preview.4` | preview | pre-release (flag set by the workflow on the draft) | named after the prerelease suffix by electron-builder (expected `preview-mac.yml`) |

Only `-preview.N` is accepted as a prerelease suffix. Artifact names are fixed and space-free
(`Favor-Printer-<version>-<arch>.dmg` and `.zip`, for `arm64` and `x64`) because GitHub rewrites spaces
in asset names, which would break the URLs in the manifest.

Check the manifest name on the first preview release and correct this table if it differs. The release
workflow already uploads whichever `*-mac.yml` electron-builder wrote.

The release workflow sets the GitHub **pre-release** flag on the draft itself: on for `-preview.N`
tags, off for stable tags. A final step fails the run if the flag is wrong. Nobody has to set or toggle
it by hand, and publishing keeps whatever the draft has.

**Stable-channel clients never see preview releases.** They only receive published, non-prerelease
releases. **Preview-channel clients see both:** the newest published release of either kind, stable or
preview. Volunteers choose the channel in the app.

## Secrets

### Required setup

Signing and notarization secrets are only safe if nobody but a maintainer can start a run that reads
them. All of the following is required before the first release. It is repository configuration, not
something the workflow can enforce for itself.

1. **Secrets live only in the `release` environment** (Settings > Environments > `release`). Do not add
   them as repository or organization secrets. The release job declares `environment: release`, so the
   secrets below resolve from that environment only.
2. **The `release` environment has required reviewers.** This is mandatory. Every release run waits for
   a maintainer to approve it before the job starts and any secret is available. Do not allow
   self-review by the person who pushed the tag when more than one maintainer exists.
3. **The `release` environment has a deployment rule that allows only `v*` tags** (Deployment branches
   and tags > Selected branches and tags > add tag pattern `v*`). Runs from branches or other tags are
   rejected.
4. **A tag ruleset protects `v*`** (Settings > Rules > Rulesets > New tag ruleset, target `v*`, restrict
   creations, updates and deletions, bypass only for maintainers). Only maintainers can create release
   tags.

On top of that the workflow itself refuses to run unless the tagged commit is on `main`. This is its
first step, before anything reads a secret: it fetches `main` and fails with `tagged commit is not on
main` when `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` is false. A maintainer cannot
release an unmerged branch by tagging it.

### The secrets

| Secret | What it is |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | The "Developer ID Application" certificate and its private key, exported from Keychain Access as a `.p12`, then `base64 -i cert.p12 \| pbcopy`. |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen when exporting the `.p12`. |
| `APPLE_API_KEY_P8_BASE64` | The App Store Connect API key (`AuthKey_<id>.p8`), base64-encoded the same way. |
| `APPLE_API_KEY_ID` | The key id of that API key. |
| `APPLE_API_ISSUER` | The issuer id shown on the App Store Connect Keys page. |

The API key needs access to notarization (Developer role or higher). Use a team key dedicated to this
repository so it can be revoked without side effects.

Rules the workflow follows, and that edits must keep:

- Secrets are passed only as environment variables of the step that needs them. They are never in
  command arguments, never echoed, and `set -x` is never enabled.
- The certificate goes into a keychain created for the run. The `.p12`, the `.p8` and the keychain are
  deleted in a final step that runs even when the build fails.
- The `.p12` password is never in a command line. openssl reads it from the environment
  (`-passin env:`), and `security import` receives unencrypted PEM copies of the certificate and key.
  Those copies and the `.p12` are deleted right after the import and again by the cleanup step.
- Pull request builds (`ci.yml`) never receive these secrets.

### `RSVP_READ_TOKEN` (vendor check, not a release secret)

`vendor-check.yml` needs to read the private `favorchurch/rsvp.favor.church` repository, which the
default `GITHUB_TOKEN` cannot do. It uses a read-only token named `RSVP_READ_TOKEN`. Unlike the signing
secrets above, it belongs to pull request checks, so it is a **repository Actions secret** of
`favorchurch/favor-printer` (Settings > Secrets and variables > Actions), not a `release` environment
secret. It cannot sign or publish anything.

Create it as a fine-grained personal access token (Settings > Developer settings > Personal access
tokens > Fine-grained tokens) owned by a maintainer or, better, a machine account:

- Resource owner: `favorchurch`. Repository access: **Only select repositories**, and select only
  `favorchurch/rsvp.favor.church`.
- Repository permissions: **Contents: Read-only**. Metadata: Read-only is added automatically.
  Nothing else.
- Set an expiry and put the renewal date in the calendar. When it expires, `vendor-check` fails closed
  on every pull request that touches `vendor/relay`.

The token is passed to one workflow step through the environment, sent to GitHub in an HTTP header
rather than a URL or command line, and masked. It is not available to pull requests from forks, so
those fail closed too when they change `vendor/relay` (see below).

Rotate a secret by replacing it in the `release` environment (`RSVP_READ_TOKEN`: in the repository
secrets). If the certificate or key may have leaked, revoke it in the
Apple Developer account first, then replace the secret.

## Cutting a release

1. Merge everything for the release to `main`. CI must be green. The release workflow only accepts a
   tag on a commit that is on `main`.
2. On a branch, set `version` in `package.json` and merge it. Use a version **higher than every
   version ever published**, including bad ones (see [Rollback](#rollback)).
3. Tag the merge commit and push the tag:

   ```sh
   git tag v1.2.3 <commit>
   git push origin v1.2.3
   ```

4. A reviewer of the `release` environment approves the run, and you wait for it to finish. The run:
   checks the tag and `package.json`, verifies `vendor/relay`, lints, typechecks and tests, builds and
   signs both architectures, notarizes the app and the DMGs, staples them, verifies them, and uploads
   to a draft release named after the tag.
5. If the run fails, fix the cause. To retry the same tag, delete the draft release (never a published
   one) and re-run the workflow. If the fix needs a code change, use a new version.

## Publishing the draft

Publishing is manual and needs an explicit OK from the person who owns the release decision.

1. Open the draft under **Releases**. Confirm it has, for each of `arm64` and `x64`, a `.dmg` and a
   `.zip`, the `.zip.blockmap` files and the `*-mac.yml` manifest.
2. Download a DMG from the draft and install it on a Mac that has never run Favor Printer. It must
   open without a Gatekeeper warning and reach the setup window. Do the same update-from-previous check
   when an earlier version is installed somewhere.
3. Get the explicit OK.
4. Publish the draft. The pre-release flag is already right, so do not toggle it. Check that the draft
   shows **Pre-release** for a `-preview.N` tag and does not for a stable tag, then click **Publish
   release** (leave **Set as a pre-release** exactly as it is), or:

   ```sh
   gh release edit v1.2.3 --draft=false
   gh release edit v1.2.4-preview.1 --draft=false
   ```

   Never add `--prerelease` or `--prerelease=false` here. Publishing a preview without its flag would
   push it to stable-channel clients.

5. Watch for the first volunteers to update. If something is wrong, go to [Rollback](#rollback).

## Local signing and notarization

Use this before the CI secrets exist, or when CI is unavailable. It produces the same artifacts as the
workflow. It needs a Mac with the Developer ID Application certificate installed in the login
keychain, and the App Store Connect API key file kept outside the repository.

```sh
export APPLE_API_KEY="$HOME/private/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

git checkout v1.2.3                      # build from the tag, with a clean tree
pnpm install --frozen-lockfile
pnpm verify:vendor && pnpm lint && pnpm typecheck && pnpm test
pnpm build

# Same release config as CI: draft-only publishing and a signed DMG.
cat > electron-builder.release.yml <<'YAML'
extends: ./electron-builder.yml
publish:
  provider: github
  owner: favorchurch
  repo: favor-printer
  releaseType: draft
dmg:
  sign: true
YAML
pnpm exec electron-builder --config electron-builder.release.yml --publish never
rm electron-builder.release.yml
```

`electron-builder.yml` alone leaves the DMG unsigned (`dmg.sign: false`), which is fine for pull request
builds but must not be notarized, so the local fallback always builds with the release config above, the
same as CI. electron-builder signs the app and the DMG with the certificate it finds in the keychain and,
because the three `APPLE_API_*` variables are set, notarizes and staples the `.app` with `notarytool`.
Artifacts are in `release/`. Confirm the DMG is signed before notarizing it:

```sh
codesign -dv --verbose=2 release/Favor-Printer-1.2.3-arm64.dmg   # must show Authority=Developer ID Application
```

If it reports `code object is not signed at all`, stop. Do not notarize it. Rebuild with the release config.

Notarize and staple each DMG, then refresh its checksum in the manifest:

```sh
for dmg in release/*.dmg; do
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" --wait
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
done

# Stapling rewrites the DMG. In the manifest (latest-mac.yml, or preview-mac.yml for a preview) replace sha512 and size of each .dmg entry:
openssl dgst -sha512 -binary release/Favor-Printer-1.2.3-arm64.dmg | base64
stat -f%z release/Favor-Printer-1.2.3-arm64.dmg
```

Verify (the same checks as the workflow). For each DMG:

```sh
codesign --verify --strict --verbose=2 release/Favor-Printer-1.2.3-arm64.dmg
spctl --assess --type open --context context:primary-signature --verbose=4 release/Favor-Printer-1.2.3-arm64.dmg
xcrun stapler validate release/Favor-Printer-1.2.3-arm64.dmg
```

And for the app inside each DMG and zip:

```sh
codesign --verify --deep --strict --verbose=2 "Favor Printer.app"
spctl --assess --type execute --verbose=4 "Favor Printer.app"
xcrun stapler validate "Favor Printer.app"
```

Upload as a **draft** only, then follow [Publishing the draft](#publishing-the-draft):

```sh
gh release create v1.2.3 --draft --title "Favor Printer 1.2.3" --notes "" \
  release/*.dmg release/*.zip release/*.zip.blockmap release/*-mac.yml
```

Do not upload the DMG `.blockmap` files: stapling made them stale and the updater only uses the zip.
Never run electron-builder with `--publish always` locally, and never pass `CSC_LINK` or the `.p8`
contents on a command line that lands in shell history.

## Rollback

**electron-updater never downgrades.** An installed app only moves to a version higher than its own
(per the electron-builder auto-update documentation, `allowDowngrade` is off by default and the app
does not enable it). Deleting or unpublishing a bad release does not move anyone who already installed
it back. The only fix is a **fix-forward release with a higher version than the bad one**.

1. Find the last good commit, the one the previous healthy release was built from.
2. Branch from it and set `package.json` to a version **higher than the bad release**. If `1.4.0` is
   bad and `1.3.2` was good, ship `1.4.1`. Reusing `1.3.2` or `1.4.0` does nothing for volunteers on
   `1.4.0`.
3. Tag, build and publish it as usual. Its code is the last good code. A real fix on top of that
   commit is also fine when it is small and obviously safe.
4. Stop the damage while that builds. If the bad release is still the latest published one, return it
   to draft (`gh release edit vX --draft`) so volunteers who have not updated yet do not receive it. If
   it is a preview, mark nothing else: stable volunteers never received it.
5. Merge the branch (or revert the bad commits) to `main` afterwards so the next release does not
   reintroduce the problem.

Volunteers who are stuck on the bad build and cannot update can install the fix-forward DMG over it
(see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)).

## What the workflows do

| Workflow | Runs on | Purpose |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main` (macOS) | install, lint, typecheck, test, unsigned `pnpm dist`. No secrets. |
| `vendor-check.yml` | pull requests, pushes to `main` | `pnpm verify:vendor` always. When `vendor/relay/**` changed, it also fetches `favorchurch/rsvp.favor.church` at the commit in `SOURCE.json` with `RSVP_READ_TOKEN`. See the guarantee below. |
| `release.yml` | tags `vX.Y.Z` and `vX.Y.Z-preview.N` on a commit that is on `main` (macOS, `release` environment) | signed build, notarization, stapling, verification, **draft** release. |
| `secret-scan.yml` | every push and pull request | gitleaks over the working tree. |

### What `vendor-check` guarantees

When a pull request or a push to `main` changes anything under `vendor/relay/**`, the workflow:

1. fails if `RSVP_READ_TOKEN` is not available (pull requests from forks, or the secret is unset). It
   fails closed and never skips the comparison;
2. fetches the RSVP repository at the 40-character commit recorded in `SOURCE.json` and fails if that
   commit does not exist there;
3. selects the relay runtime files the way the RSVP sync script does: the files reached from
   `embedded.ts` and `index.ts` by following relative imports (no tests, docs, simulator or
   packaging), and fails if `vendor/relay` has a file that is not in that set or lacks one that is;
4. requires every `vendor/relay` runtime file to equal the file at that commit **byte for byte**;
5. recomputes the sha256 of every file from the fetched tree and requires `SOURCE.json` to list exactly
   those hashes.

So a merged `vendor/relay` is exactly the relay runtime of a commit that exists in the RSVP repository,
and `SOURCE.json` cannot be edited to say otherwise. It does **not** prove that the commit is on the
RSVP `main` branch or has been reviewed there. As an extra check, not the guarantee, a pull request that
changes `vendor/relay/**` must also come from the `sync/relay-from-rsvp` branch of this repository,
which the RSVP relay-sync workflow pushes with `FAVOR_PRINTER_SYNC_TOKEN`.

`release.yml` publishes through electron-builder with `releaseType: draft` (set in a generated
`electron-builder.release.yml` that extends `electron-builder.yml`, and backed up by `EP_DRAFT=true`).
A final step fails the run if the release is not a draft or an expected asset is missing. An early
step refuses to touch a tag that already has a published release, and the same check runs again
immediately before the upload, because the build and notarization can take a long time. If a maintainer
published the release in between, the run aborts without uploading.

Two things the release run does that `electron-builder.yml` alone does not: it signs the DMG itself, so
it can be notarized, stapled and assessed on its own, and it refreshes the DMG checksums in the update
manifest after stapling.
