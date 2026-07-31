# Releasing Casebook

Casebook updates itself. Someone running it will be offered whatever this
procedure last published, so the short version is: **a tag is a promise to
everyone already running the app.**

## Where the version lives

`package.json` `version` is the only source of truth. It becomes
`app.getVersion()` inside the app, and that is the number the updater compares
against GitHub.

A `vX.Y.Z` tag must name the same version as `package.json`. CI checks this and
fails the release rather than publishing a build that misreports itself — an app
that believes it is 1.2.0 while the release says 1.3.0 will re-offer the same
update forever.

## Cutting a release

```sh
# 1. Set the version. This commit is the release.
npm version 1.2.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Casebook 1.2.0"

# 2. Tag it and push both.
git tag v1.2.0
git push origin main v1.2.0
```

CI then builds on macOS, verifies the signature and the fuses, and publishes a
release with `Casebook-mac-arm64.zip` and `Casebook-mac-arm64.dmg` attached.

Nothing else needs doing. The install script and the updater both fetch from
`releases/latest/download/<asset>`, which GitHub points at the newest release
that is not a prerelease — so publishing is what makes a version live.

## What a push to `main` does

Builds the app and keeps the result as a workflow artifact for 14 days, so
packaging breakage shows up on the commit that caused it. It publishes nothing
and prompts nobody. Only tags are releases.

## What the updater reads

`GET /repos/EngineeredDev/casebook/releases/latest` → `tag_name`, compared
against `app.getVersion()`. Prereleases and drafts are invisible to that
endpoint, which is the mechanism doing the work here: an untagged build cannot
reach anyone by accident.

There is no signature verification — there is no certificate to verify against,
and there is not going to be one (see the README on Gatekeeper). The updater
trusts GitHub over HTTPS, pinned to this repository. That is an acceptable trust
model for a personal tool and would not be for broader distribution.

## Versioning

Ordinary semver, read from the clinician's side rather than the code's:

- **Patch** — fixes and adjustments to things that already exist.
- **Minor** — new capability she would notice.
- **Major** — something about the app she already knows stops being true.

Anything touching `data.json`'s shape needs a migration in `src/main/storage.ts`
and a `DATA_VERSION` bump, which is a separate thing from the app version and
usually a good reason to be cautious about the release that carries it.
