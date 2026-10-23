# ADR-0021: Schema safety gates: migration linter, gated release step, snapshot drift check

- **Status:** Accepted
- **Date:** 2026-10-22
- **Scope:** Drizzle PostgreSQL migration linting, allowlisted exceptions, physical schema snapshots, the gated release preset, the boot-time guard, and the composite GitHub Action; not the migrator itself
- **Related:** [ADR-0006](./0006-executable-transaction-scopes.md) · [ADR-0007](./0007-domain-repositories-and-named-projections.md) · [ADR-0012](./0012-v4-replacement-and-release-boundary.md)

## Context

The production schema rules are standing instructions: never remove, rename or retype a production column; additive is not the same as non-blocking; data backfills do not run inside the DDL transaction; migrations are a gated release step from CI, never a boot step. They were enforced by review. Review catches most of it and none of it reliably, and every consumer that moved migrations out of boot wrote the same release step again: four consumers (SAPI-148, done; SAPI-184; SAPI-221; SAPI-270) each carry that ticket.

Rails solved this with `strong_migrations`, which refuses the unsafe statement and prints the safe recipe, and with `db:migrate` as a release step whose schema dump CI diffs. Drizzle has `drizzle-kit generate` and `migrate`, a journal and a schema snapshot of its own, but nothing that refuses an unsafe migration, nothing that compares the physical database with what the migrations should have produced, and nothing that stops `migrate()` from being called at boot.

The compatibility distribution's `ship-api migrate-orm` and the migration playbook (`docs/MIGRATION_V3_TO_V4.md` section 5) already state that PostgreSQL is authoritative and that an empty generated diff is not data-safety evidence. This decision gives that stance executable form.

## Decision

### A focused package, default-off

`@sixthsummit/ship-schema-lint` is an optional package with no runtime footprint in an application. It depends on `commander` and `pg` only. Existing consumers change nothing until they add it; the kernel, adapters and compatibility distribution do not import it.

### Linting is static, journal-ordered and conservative

`ship-schema-lint check <migrations-dir>` reads migrations in `meta/_journal.json` order, splits each file into statements with a tokenizer that respects strings, quoted identifiers, comments and dollar quoting, and evaluates nine rules: `table-drop`, `table-rename`, `column-drop`, `column-rename`, `column-type-change`, `not-null-without-default`, `set-not-null`, `non-concurrent-index`, `backfill-in-ddl-transaction`. Table state is tracked across the ordered set, so a table created in the same migration is exempt from the existing-table rules. Every finding carries a safe multi-step recipe. The rules match Drizzle-shaped PostgreSQL DDL with statement patterns rather than a full SQL grammar; unknown statements pass through unflagged, which is the conservative failure mode for a linter whose job is to block the known-unsafe operations.

### Exceptions are explicit, justified and auditable

An exception names a migration tag and a rule and requires a justification of at least twelve characters, either in a JSON allowlist file or in an inline `-- ship-schema-lint: allow <rule> <justification>` comment directly above the statement. An entry that matches nothing fails the check, so the allowlist cannot drift into fiction. `baseline` (or `--since`) adopts the linter on a repository with historical migrations without rewriting history.

### The physical schema is the snapshot

The snapshot is captured from `pg_catalog` (tables, columns via `format_type`, defaults, identity and generated markers, constraints via `pg_get_constraintdef`, indexes via `pg_get_indexdef`, enums), sorted by code point in code rather than by database collation, with Drizzle's ledger excluded. It is compared structurally and reported as added, removed or changed paths with expected and actual values. The committed snapshot is regenerated only when migrations change; a diff without a migration change is a hand edit, in CI's disposable database or in the target.

### Migrations are a gated release step and the boot path refuses them

`ship-schema-lint release` runs guard, lint, migrate (`drizzle-kit migrate`, or an explicit `--migrate-command`), then snapshot check or write. The guard refuses with exit code `3` unless `SHIP_RELEASE_STEP=1`; the variable belongs to the release job and never to an application runtime environment. `assertMigrationsApplied()` replaces boot-time `migrate()`: it applies the migrator's own pending rule against the ledger and throws `PendingMigrationsError` instead of applying anything. `ship-schema-lint pending` is the same guard for entrypoints. The composite action `.github/actions/schema-safety` wraps the preset so consumers adopt a required check rather than writing the job.

### Exit codes are part of the contract

`0` clean, `1` findings, stale allowlist entries or drift, `2` invalid input, `3` refused. `--json` prints the structured result on every command.

## Consequences

- An unsafe migration fails CI with its recipe instead of reaching review; a deliberate exception is a visible, justified line in the diff.
- A hand edit to a table, in a migration file after the snapshot was taken or directly in a database, is caught by the drift check before the deploy, not after it.
- Consumers adopt one preset and one action; SAPI-184, SAPI-221 and SAPI-270 become adoption tasks rather than implementations.
- The boot guard turns a forgotten release step into a fast, named startup failure rather than a migration applied by whichever instance started first.
- The linter is not a grammar. New Drizzle output shapes or hand-written statements outside its patterns pass through; the rule set grows from evidence, with a fail-and-pass fixture per rule.
- `CREATE INDEX CONCURRENTLY` still cannot run inside Drizzle's per-file transaction; the recipe says so and the allowlist records the decision when a plain index on a small table is acceptable.
- The snapshot covers tables, columns, constraints, indexes and enums. Views, functions, triggers and policies are not yet captured; a consumer that relies on them has no drift coverage for them until the snapshot grows.

## Rejected alternatives

### Enforce the rules inside `drizzle-kit generate`

Rejected because generation is where the unsafe statement is produced, not where it is reviewed; the consumer runs generate locally and the check must run in CI on the committed file regardless of how it was produced, including by hand.

### Diff Drizzle's own `meta/*_snapshot.json`

Rejected because it records what the schema source says, not what the database contains. The hand edit this decision must catch is precisely the one that leaves the Drizzle snapshot untouched.

### A full SQL parser

Rejected for this release because the migrations under lint are Drizzle output with a small, stable shape, and a grammar would make the package heavier than the applications that use it. The tokenizer plus statement patterns are tested per rule and extend by adding a pattern and a fixture.

### Detect boot-time migration heuristically

Rejected because a heuristic (process role, open ports, environment names) either misfires on legitimate release runners or is trivially satisfied by the very script it is meant to stop. An explicit release-context variable plus a boot guard that never migrates is checkable and honest.

### Keep the release step in each consumer

Rejected because it is the same work four times with four chances to diverge, and because a framework-owned step is the only way the snapshot format, exit codes and recipes stay consistent across consumers.

## Evidence

- `packages/schema-lint/src/lint.test.ts`: one failing and one passing fixture per rule under `src/__fixtures__/rules/`, allowlist file and inline forms, stale entries, baseline handling, journal ordering.
- `packages/schema-lint/src/cli.test.ts`: exit codes for every command, JSON mode, the guard refusal, the ordered release steps with an injected migrator and connection, migrator failure and snapshot drift.
- `packages/schema-lint/src/snapshot.integration.test.ts` (real PostgreSQL): the boot guard before and after `migrate`, the captured catalog, an induced hand edit to the database and an edited migration file both reported as drift through the release step.
- `fixtures/consumers/customized`: generated migrations, committed `schema.snapshot.json`, lint in the `check` gate, and `src/schema-safety.integration.test.ts` proving the snapshot matches both the migrations and `pushSchema` of the schema source, and that a hand edit is caught, from the packed packages.
