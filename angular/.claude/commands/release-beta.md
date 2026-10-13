---
description: Walk a release of @sixthsummit/ship-angular (alpha snapshot from dev, stable via main) — pre-flight checks only, never a local publish
allowed-tools: Bash(pnpm:*), Bash(npm:view), Bash(npm:whoami), Bash(git:*), Bash(node:*), Read, Edit
---

# /ship:release-beta

Walks a release of `@sixthsummit/ship-angular` through the **changesets** flow (see `RELEASE_GUIDE.md`). Publication is CI-only:

- **Alpha snapshot** — every merge into `dev` whose CI run passes publishes `4.x.y-alpha-<datetime>` under the `alpha` dist-tag. Nothing to run by hand; this command checks that a merge _will_ produce one.
- **Stable** — a plain `dev` → `main` PR; `release.yml` on `main` opens the "chore: version packages" PR and merging it publishes under `latest`.

This command's job is the pre-flight discipline. It never runs `changeset publish`.

## Steps

1. **Pre-flight checks** (do not skip):
   - Confirm we're on `dev` (for a snapshot) or preparing a `dev` → `main` PR (for a stable release). If not, refuse and print the current branch.
   - `git status --porcelain` — if non-empty, refuse with a "commit or stash first" message.
   - `git fetch origin` and check we're up to date with `origin/dev`.
   - `.changeset/pre.json` must **not** exist (pre mode is retired; CI refuses it). If it does, stop and ask.
   - `pnpm changeset status` — list the pending changesets and the version they'll produce. If there are NO pending changesets, stop: a merge would publish nothing; offer to write a changeset for the unreleased work instead.
   - Run `pnpm ci`. Must pass end-to-end.

2. **Preview the snapshot** (optional, on request):
   - `pnpm exec changeset version --snapshot alpha && pnpm sync-version` — show the computed version and the touched files (`../packages/angular/package.json`, `CHANGELOG.md`, `version.ts`, root mirror, template exact pin), then revert with `git checkout -- .` and `git clean -fd`. Do not commit.

3. **Confirmation prompt**:
   - Show the current version (`../packages/angular/package.json#version`) and the version changesets will produce (from `changeset status`).
   - Ask which path: **(a) snapshot** — merge the reviewed PR into `dev`; the Release workflow publishes once CI passes. **(b) stable** — open the `dev` → `main` PR; after it merges, review and merge the generated version PR on `main`, then merge `main` back into `dev`.
   - Never publish locally. If CI is unavailable, fix CI.

4. **Post-flight**:
   - Snapshot: `npm view @sixthsummit/ship-angular@alpha version` — confirm the registry shows the new `-alpha-<datetime>` version; the Release run's step summary prints it.
   - Stable: `npm view @sixthsummit/ship-angular version` and `npm view @sixthsummit/ship-angular dist-tags`; confirm the GitHub Release exists.
   - Print a one-line summary: "Released vX.Y.Z[-alpha-<datetime>] to GitHub Packages (dist-tag: alpha|latest)."

## Notes for Claude

- **Publishing is irreversible** in the sense that it cannot be undone after the registry window. Only the workflow publishes; never bypass it.
- If the user has not authenticated with the registry, `npm view` will fail. Surface the auth error clearly and link to `RELEASE_GUIDE.md`.
- **Exact pins:** recommend `@sixthsummit/ship-angular@4.x.y-alpha-<datetime>` for client sites and fixtures; `@alpha` moves on every `dev` merge.
