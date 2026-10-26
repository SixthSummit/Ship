# @sixthsummit/ship-schema-lint

## 0.1.0

### Minor Changes

- 7316650: Add `@sixthsummit/ship-schema-lint`, the schema safety toolkit for Drizzle PostgreSQL migrations: `check` lints migrations in journal order against the production column rules (table/column drop, rename and retype, NOT NULL without a default, SET NOT NULL, non-concurrent index on an existing table, backfill inside the DDL transaction) and prints the safe recipe for each finding, with justified allowlist entries (file or inline comment), `baseline` adoption, `--json` and stable exit codes; `snapshot write|check` captures a canonical `pg_catalog` schema snapshot and fails on drift; `release` is the gated release step (guard, lint, `drizzle-kit migrate` or a custom migrator, snapshot) that refuses to run without `SHIP_RELEASE_STEP=1`; `assertMigrationsApplied()` and `pending` replace boot-time `migrate()` and fail fast on pending migrations without applying them. A composite GitHub Action under `.github/actions/schema-safety` wraps the release step.
