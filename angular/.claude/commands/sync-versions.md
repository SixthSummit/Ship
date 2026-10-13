---
description: Sync ../packages/angular/src/version.ts and check version drift across package.json files
allowed-tools: Bash(node:*), Bash(pnpm:*), Read, Grep
---

# /ship:sync-versions

Two-step:

1. Regenerate `../packages/angular/src/version.ts` from `../packages/angular/package.json`'s version field.
2. Audit version drift across the repo's `package.json` files and report.

## Steps

1. Run `pnpm sync-version` from the repo root. This invokes `node scripts/sync-version.js`.
2. After regeneration, gather the version fields from:
   - `package.json` (root)
   - `../packages/angular/package.json` (the published library)
   - `../packages/angular/templates/default/package.json` (the template — its `version` field is decorative; what matters is the `@sixthsummit/ship-angular` dep range)
3. Audit alignment:
   - Root version should match `../packages/angular` version (or be intentionally different and documented).
   - Template's `@sixthsummit/ship-angular` dep range should be `^<current published version>` or `^<current alpha/beta version>` for prerelease lines.
   - Template's `firebase`, `@angular/*`, `@angular-eslint/*` versions should not have major-version drift across the repo's other package.json files.
4. Report:
   - ✓ if everything aligns.
   - ⚠ with a specific drift report (e.g., "Template uses `firebase: ^10.0.0` but core uses `^11.10.0`") if not.
   - Suggest the specific edits to bring things back in line.

## Notes for Claude

- This is read-mostly: the only write is `version.ts` regeneration via the sync script.
- Don't auto-fix the drifts — surface them to the user. Drifts may be intentional (e.g., a template ranged `^11` against a library pinned at exactly `11.10.0`).
- Consider this command a "doctor lite" — the full `ship-angular doctor` lands in Phase 3 and includes runtime checks (missing providers, SSR misconfig, etc.).
