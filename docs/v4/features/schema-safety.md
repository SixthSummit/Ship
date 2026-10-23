# Schema safety

> **Kernel-era tooling:** `@sixthsummit/ship-schema-lint` is an optional,
> focused package. It works on any Drizzle PostgreSQL migrations directory and
> installs nothing at runtime. Existing consumers opt in by adding it; nothing
> changes for a consumer that does not.

The production schema rules are short: never remove, rename or retype a
production column; additive is not the same as non-blocking; data moves outside
the DDL transaction; migrations are a gated release step, never a boot step.
Until now they were enforced by review. `ship-schema-lint` enforces them in CI,
prints the safe recipe for each violation, records what the migrations produce
in a canonical snapshot that CI diffs, and ships the release step every consumer
was hand-rolling.

```sh
pnpm add -D @sixthsummit/ship-schema-lint
```

## Lint migrations

```sh
ship-schema-lint check drizzle --allowlist schema-lint.allowlist.json
```

The linter reads the directory in `meta/_journal.json` order (the order the
migrator applies), splits each file into statements (strings, dollar-quoted
bodies and comments are respected), and tracks which tables each migration
creates. A table created in the same migration is new and empty, so the
existing-table rules do not apply to it.

| Rule | Fires on | Safe recipe (summary) |
| --- | --- | --- |
| `table-drop` | `DROP TABLE` | Stop readers first, keep the table one release cycle, archive, then drop with a justification |
| `table-rename` | `ALTER TABLE ... RENAME TO` | New table or view, dual-write, batched backfill, retire the old name |
| `column-drop` | `ALTER TABLE ... DROP COLUMN` | Remove readers and writers first, keep the column one release cycle, then drop with a justification |
| `column-rename` | `ALTER TABLE ... RENAME COLUMN` | Add the new column, dual-write, batched backfill, retire the old column |
| `column-type-change` | `ALTER COLUMN ... [SET DATA] TYPE` | New column with the target type, dual-write, backfill, switch reads, retire |
| `not-null-without-default` | `ADD COLUMN ... NOT NULL` without `DEFAULT` or identity, on an existing table | Nullable or constant default, batched backfill, `CHECK ... NOT VALID`, validate, then `SET NOT NULL` |
| `set-not-null` | `ALTER COLUMN ... SET NOT NULL` on an existing table | `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT`, then `SET NOT NULL` (PostgreSQL 12+ skips the scan) |
| `non-concurrent-index` | `CREATE [UNIQUE] INDEX` without `CONCURRENTLY` on an existing table | `CREATE INDEX CONCURRENTLY` outside the migration transaction, or allowlist a small table |
| `backfill-in-ddl-transaction` | `UPDATE`, `DELETE`, `MERGE` or `INSERT ... SELECT` in a migration that also contains DDL | Schema-only migrations; data moves in a separate migration or a batched job. `INSERT ... VALUES` seeds are not flagged |

Every finding prints the file, line, statement, why it is unsafe, and the
numbered recipe. `--json` prints the structured result for tooling.

Exit codes are stable: `0` clean, `1` findings (or stale allowlist entries, or
snapshot drift), `2` invalid input (missing directory, unreadable allowlist,
malformed journal, bad flags), `3` refused (the release step ran outside a
release context).

### Allowlist with justification

The rare deliberate exception is allowed per migration tag and rule, and the
justification is required (at least 12 characters). Either in a file:

```json
{
  "baseline": "0041_last_historical",
  "allow": [
    {
      "migration": "0042_drop_legacy_flag",
      "rule": "column-drop",
      "justification": "readers removed in 2026.10.1; column archived to cold storage"
    }
  ]
}
```

or inline, in the comment directly above the statement:

```sql
-- ship-schema-lint: allow column-drop readers removed in 2026.10.1; archived to cold storage
ALTER TABLE "orders" DROP COLUMN "legacy_flag";
```

An allowlist entry that matches nothing fails the check so the file stays
truthful. `baseline` (or `--since <tag>`) suppresses findings up to and
including a historical migration when adopting the linter on an existing
project; those migrations still feed table state.

## Migrations as a gated release step

```sh
SHIP_RELEASE_STEP=1 ship-schema-lint release \
  --migrations drizzle \
  --allowlist schema-lint.allowlist.json \
  --snapshot schema.snapshot.json
```

The preset runs, in order: the guard, the lint, `drizzle-kit migrate`
(`--drizzle-config` is forwarded; `--migrate-command "<command>"` substitutes
another migrator), then the snapshot check against the target database. Any
step that fails stops the rest, and the exit code says which kind of failure it
was. `--dry-run` lints and prints the plan without applying anything.
`--write-snapshot` captures the snapshot instead of verifying it; use it in the
same change that adds a migration.

The guard is the refusal: without `SHIP_RELEASE_STEP=1` the command exits `3`
and applies nothing. The variable belongs in the release job's environment and
never in an application runtime environment, so a `start` script or container
entrypoint that still calls the command fails loudly instead of migrating at
boot.

Replace the boot-time `migrate()` call with the guard, which never applies
anything:

```ts
import { assertMigrationsApplied } from "@sixthsummit/ship-schema-lint";

// Where `await migrate(db, { migrationsFolder })` used to run at startup:
await assertMigrationsApplied({ client: pool, migrationsDir: "drizzle" });
```

It reads the journal and Drizzle's `drizzle.__drizzle_migrations` ledger with
the migrator's own rule (an entry is pending when its `when` is newer than the
latest ledger row) and throws `PendingMigrationsError` naming the pending tags.
`ship-schema-lint pending --migrations drizzle` is the same check for a
container entrypoint or a readiness script.

### GitHub Actions

The composite action under `.github/actions/schema-safety` wraps the preset.
Give it a disposable PostgreSQL service so CI verifies the committed snapshot
against what the migrations produce, and make the job a required check before
the deploy job:

```yaml
jobs:
  schema:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_PASSWORD: ship, POSTGRES_USER: ship, POSTGRES_DB: ship }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U ship" --health-interval 5s
          --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: SixthSummit/Ship/.github/actions/setup-node-pnpm@dev
      - run: pnpm install --frozen-lockfile
      - uses: SixthSummit/Ship/.github/actions/schema-safety@dev
        with:
          migrations-dir: drizzle
          database-url: postgres://ship:ship@localhost:5432/ship
          snapshot: schema.snapshot.json
          allowlist: schema-lint.allowlist.json

  deploy:
    needs: [schema]
    # ... run the same action against the target database with the
    # production DATABASE_URL secret, then deploy.
```

Running the action against the target database in the deploy job gives the
same three guarantees in production: the migrations were linted, they were
applied before the new release starts, and the target's physical schema matches
the committed snapshot. A hand edit to a production table surfaces there as
drift before the deploy, not as a page later.

## Schema snapshot

```sh
ship-schema-lint snapshot write --out schema.snapshot.json   # after migrating
ship-schema-lint snapshot check --snapshot schema.snapshot.json
```

The snapshot is read from `pg_catalog` rather than from Drizzle's own
`meta/*_snapshot.json`, because the question it answers is different: not "what
does the schema source say" but "what does the database physically contain".
It records, per schema (default `public`), every table with its columns
(`format_type`, nullability, default expression, identity and generated
markers), constraints (`pg_get_constraintdef`), indexes (`pg_get_indexdef`),
and every enum with its labels. Objects are sorted by code point in code, not
by the database collation, so the same schema serializes identically on every
PostgreSQL instance. Drizzle's migrations ledger is always excluded.

`check` prints a structural diff (`+` in database only, `-` in snapshot only,
`~` changed, with the expected and actual values) and exits `1`. The committed
file changes only through the release step or `snapshot write` after a
migration was generated; a diff with no migration change in the same commit is
a hand edit.

## API

Everything the CLI does is exported for programmatic use:
`lintMigrations` / `lintMigrationSql` / `formatLintReport`,
`parseAllowlist` / `readAllowlistFile`, `captureSchemaSnapshot` /
`diffSchemaSnapshots` / `checkSchemaSnapshot` / `writeSchemaSnapshot`,
`assertMigrationsApplied` / `migrationsStatus`, `runRelease`,
`splitSqlStatements`, `evaluateStatement`, `RULE_IDS`, `RECIPES`, and
`SCHEMA_LINT_EXIT`. `runRelease` accepts an injected command runner and
database connection so a consumer can test its release wiring without Docker.

## Adoption path

1. Add the package, a `drizzle.config.ts` with `out: "./drizzle"`, and
   `ship-schema-lint check drizzle` to the `check` script.
2. If the repository has historical migrations that would not pass today, set
   `baseline` in the allowlist to the last historical tag. New migrations are
   linted from there.
3. Generate `schema.snapshot.json` by applying the migrations to a disposable
   database and running `snapshot write`; commit it.
4. Replace boot-time `migrate()` with `assertMigrationsApplied()`.
5. Add the composite action as a required check before deploy, and run the
   same preset against the target database in the deploy job with
   `SHIP_RELEASE_STEP=1`.

The customized golden consumer (`fixtures/consumers/customized`) is the
reference: its migrations are generated from `src/schema.ts`, its `check`
script lints them, `schema.snapshot.json` is committed, and
`src/schema-safety.integration.test.ts` proves against real PostgreSQL that the
snapshot matches both the migrations and the schema source, that the boot
guard refuses pending migrations, and that an induced hand edit is caught.

## Consumers

Two named consumers prove the capability. Vault Drive already moved migrations
to a gated release step (SAPI-148) and adds the linter and snapshot check to
that step. Tortlink v2 adopts the preset and the action instead of hand-rolling
its release step (SAPI-184). AFHC's 134 historical migrations (SAPI-270) are
the stress test for the `baseline` adoption path. Consumer wiring lives in the
consumer repositories; this repository ships the package, the action, the
reference consumer and the evidence.

## Limits

- The linter parses Drizzle-shaped PostgreSQL DDL with a tokenizer and
  statement patterns, not a full SQL grammar. Exotic statements pass through
  unflagged; the rules are conservative about what they match rather than
  guessing.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction and Drizzle
  applies each migration file in one. The recipe says so; the practical options
  are an operational step or a justified allowlist entry for a small table.
- The snapshot captures tables, columns, constraints, indexes and enums. Views,
  functions, triggers, policies and sequences outside identity columns are not
  captured yet.
- The release preset shells out to `drizzle-kit migrate` (or the command you
  give it); it does not reimplement the migrator.
