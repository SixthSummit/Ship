---
event: PostToolUse
matcher: 'Edit|Write'
description: When the assistant edits ../packages/angular/package.json, automatically regenerate src/version.ts so the constant doesn't drift from the manifest.
---

# Post-edit version sync hook

Whenever the assistant edits or writes
`../packages/angular/package.json`, this hook runs `pnpm sync-version` so
`../packages/angular/src/version.ts` reflects the latest manifest version.

## Behavior

- Triggers on `Edit` or `Write` whose target path matches
  `../packages/angular/package.json`.
- Runs `pnpm sync-version`.
- Result is informational only (doesn't block — sync-version is
  idempotent and shouldn't fail under normal conditions).

## Why

Phase 0 found `VERSION` was 22 versions stale because no hook kept it in
sync. The prebuild script catches it on every build, but builds aren't
the only path — direct edits to `package.json` (e.g., during a release)
should re-emit the constant immediately so a subsequent commit doesn't
ship a stale version.
