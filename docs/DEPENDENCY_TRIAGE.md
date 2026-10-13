# Dependency triage — 2026-10-12

The locked monorepo audit now reports zero high, critical or low findings and one moderate match. There are no known applicable findings in this audit snapshot. This records the current dependency graph, not a guarantee about future advisories.

## Resolved

- Hono: raised direct minimums and the root override to 4.13.7, resolving eleven remaining advisory matches (ten moderate, one low).
- ip-address: root override `^10.7.1`, resolving two moderate matches in the MCP SDK / express-rate-limit chain.
- Removed obsolete audit allowlist entries. Both audit configurations now have empty allowlists.

## Remaining false match

`pnpm audit --json` reports [GHSA-m2h2-264f-f486](https://github.com/advisories/GHSA-m2h2-264f-f486) / CVE-2022-25844 against path `angular`, originally version 4.1.0 (the private workspace version advances with ShipAngular). That advisory affects the npm AngularJS package named `angular`.

The path here is a private workspace importer: `angular/package.json` names it `ship-angular`, with `private: true`. It is not an installed AngularJS package. The lockfile has no `angular@...` package or snapshot; framework dependencies use modern `@angular/*` packages. This is an importer-name collision in the audit report. No advisory-wide exception is added, so future actual AngularJS dependencies remain visible.

Reproduce with `pnpm audit --json`, inspect `angular/package.json`, and search package/snapshot keys in `pnpm-lock.yaml`. CI continues to fail at high severity; the isolated runtime package audit remains a separate gate. Revisit this assessment if the importer or dependencies change.
