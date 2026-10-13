---
description: Check ShipAngular release readiness using the root monorepo release guide
allowed-tools: Bash(pnpm:*), Bash(npm:view), Bash(git:*), Read
---

# Release readiness

Follow the root `RELEASE_GUIDE.md`. Inspect the checkout, run `pnpm -w release:preview`, and report the exact pending package versions and changeset IDs. Run relevant CI checks before proposing publication. Publishing is manual, gated by `SHIP_PUBLISH_ENABLED`, and uses npmjs trusted publishing: alpha from `dev`, stable from `main` after version bookkeeping. Never publish locally or claim a merge publishes automatically. Do not mutate or discard local work to preview a snapshot.
