---
name: release-beta
description: Use when the user asks to "cut an alpha", "publish a snapshot", "release a prerelease", "cut a stable release", or any phrasing that maps to releasing @sixthsummit/ship-angular. Walks the changesets flow — pending-changeset check, the alpha snapshot from dev, the stable version PR on main, and post-flight verification.
---

# Release @sixthsummit/ship-angular

This skill walks through releasing with **changesets** — the same flow as ShipAPI. It is the longer-form counterpart to the `/ship:release-beta` slash command — use this skill when the user wants the playbook explained, a dry run, or there's an unusual edge to handle.

## How releases work here (mental model)

- Every consumer-visible change lands with a `.changeset/*.md` file (`pnpm changeset`) declaring `major`/`minor`/`patch` + a CHANGELOG summary.
- **Alpha snapshots from `dev`.** Every merge into `dev` runs CI; when that run succeeds, `release.yml` checks out the same commit, runs `changeset version --snapshot alpha` (calculated version + `-alpha-<datetime>`), `pnpm sync-version`, builds, and publishes under the `alpha` dist-tag. Nothing is committed and no PR is opened; the changeset files stay on `dev`.
- **Stable from `main`.** `dev` → `main` is a plain merge. On `main`, `release.yml` waits for CI on the pushed commit, then `changesets/action` opens/updates the **"chore: version packages"** PR (version bump + CHANGELOG + `sync-version` mirrors). **Merging that PR publishes** under `latest` and creates the GitHub Release. Afterwards `main` is merged back into `dev`.
- Pre mode (`.changeset/pre.json`) is retired; CI refuses the file on any branch.

## When NOT to use this skill

- The user wants to publish a _new_ package (not a new version of an existing one). That needs `.changeset/config.json` + workspace + `publishConfig` setup first.
- The user wants to publish from a laptop. There is no manual path; publication only happens in `release.yml`.

## Pre-flight checks (mandatory)

1. **Branch.** Confirm we're on `dev` (the 4.x trunk). Refuse if not.
2. **Working tree clean.** `git status --porcelain` must be empty. Refuse otherwise.
3. **Up to date.** `git fetch origin` and confirm `dev` matches `origin/dev`. If not, ask whether to push or pull.
4. **No pre mode.** `.changeset/pre.json` must not exist. If it does, stop and ask — it has to be removed (`pnpm changeset pre exit`) before anything can release.
5. **Pending changesets.** `pnpm changeset status` — if empty, there is nothing to release. Offer to write changesets for unreleased work rather than forcing a bump.
6. **CI must pass locally.** Run `pnpm ci` end-to-end. If anything fails, stop and fix; do not release a broken snapshot.
7. **Bundle measurement.** Run `pnpm measure-bundle` and record the size for the release notes.

## Alpha snapshot

8. Show the user: current version, pending changesets, and the version `changeset status` says will be produced (the snapshot appends `-alpha-<datetime>` to it). **Get an explicit yes** before merging anything into `dev`.
9. Merge the reviewed PR into `dev`. Watch the CI run, then the Release run it triggers; its step summary prints the published version.
10. If the Release run fails after `changeset publish` started, do **not** retry blindly. Diagnose: auth (`packages: write`, org package settings), registry state (`npm view @sixthsummit/ship-angular versions --json`), or a version that already exists.

## Stable release

11. Open a PR from `dev` into `main` (plain merge, no version edits). After it merges, `release.yml` opens the version PR on `main`; approve its workflow runs, review the diff (package.json bump, CHANGELOG, `version.ts`, root mirror, template `^x.y.z` range), and merge it. That merge publishes under `latest`.
12. Open a PR from `main` into `dev` so `dev` receives the bump and the consumed changesets. Until it merges, `dev` snapshots keep re-publishing the already-released changesets at the old calculated version.

## Post-flight

13. Verify on the registry: `npm view @sixthsummit/ship-angular@alpha version` (snapshot) or `npm view @sixthsummit/ship-angular version` and `npm view @sixthsummit/ship-angular dist-tags` (stable).
14. Stable only: check the GitHub Release was created with the changelog (CI does this via `createGithubReleases`).
15. Smoke the published artifact: `pnpm dlx @sixthsummit/ship-angular@<exact version> create smoke-test --skip-install`.
16. Update release notes with: one-line summary, **agent eval pass-rate** (Phase 4 onward), **bundle size delta** vs. previous release, phase reference.

## Dry-run mode

If the user asks for a dry run:

- Run steps 1–8 (all pre-flight + show the planned version).
- `pnpm exec changeset version --snapshot alpha && pnpm sync-version` (requires `GITHUB_TOKEN`, see Gotchas). Show the computed version and the full diff, then **revert it** with `git checkout -- .` and `git clean -fd`. Snapshot versioning consumes the changeset files in the working tree; the revert restores them. Do not commit, do not publish.

## Gotchas

- **`npm publish` is irreversible.** You can deprecate but not unpublish (after 72h). Always require explicit user confirmation before merging a release-producing PR.
- **Don't `--no-verify` past a failing pre-commit hook.** If the hook fails, the release shouldn't go out.
- **`dev` is the trunk.** `main` is stable-only. Don't cut releases from feature branches.
- **Exact pins.** `@alpha` moves on every `dev` merge; client sites, staging branches, and joint-conformance fixtures pin the exact `4.x.y-alpha-<datetime>` version. A caret range on a prerelease is almost never what you want.
- **Snapshot versions never land in git.** The version in `../packages/angular/package.json` on `dev` stays at the last stable release; only the published tarball carries `-alpha-<datetime>`.
- **`changeset version` needs `GITHUB_TOKEN`** in the env locally (`export GITHUB_TOKEN="$(gh auth token)"`) — the changelog-github generator resolves PR links through the GitHub API. It fails fast and cleanly without it.
- **Registry credentials live outside this repo.** If the user hasn't authenticated, `npm view` fails with a clear error; don't try to fix it without involving them.
