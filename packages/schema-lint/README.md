# @sixthsummit/ship-schema-lint

Schema safety toolkit for Drizzle PostgreSQL migrations in Ship applications:
a migration linter that enforces the production column rules, a canonical
schema snapshot that CI diffs, and a gated release preset so migrations never
run at boot.

```sh
# Lint pending migrations; each finding prints the safe multi-step recipe.
ship-schema-lint check drizzle --allowlist schema-lint.allowlist.json

# Gated release step: lint -> drizzle-kit migrate -> snapshot check.
SHIP_RELEASE_STEP=1 ship-schema-lint release --migrations drizzle --snapshot schema.snapshot.json

# Capture the snapshot after migrating (commit the file).
ship-schema-lint snapshot write --out schema.snapshot.json

# Boot-time guard: exit 1 when migrations are pending; never applies them.
ship-schema-lint pending --migrations drizzle
```

Rules: `table-drop`, `table-rename`, `column-drop`, `column-rename`,
`column-type-change`, `not-null-without-default`, `set-not-null`,
`non-concurrent-index`, `backfill-in-ddl-transaction`. Tables created in the
same migration are exempt from the existing-table rules.

Exit codes: `0` clean, `1` findings or snapshot drift, `2` invalid input,
`3` refused (release step outside `SHIP_RELEASE_STEP=1`). `--json` prints the
structured result.

Allowlist entries name a migration tag, a rule, and a required justification:

```json
{
  "baseline": "0041_last_historical",
  "allow": [
    { "migration": "0042_drop_legacy", "rule": "column-drop",
      "justification": "readers removed in 2026.10.1; data archived" }
  ]
}
```

or inline, directly above the statement:

```sql
-- ship-schema-lint: allow column-drop readers removed in 2026.10.1; data archived
ALTER TABLE "orders" DROP COLUMN "legacy_flag";
```

Replace boot-time `migrate()` with the guard:

```ts
import { assertMigrationsApplied } from "@sixthsummit/ship-schema-lint";

await assertMigrationsApplied({ client: pool, migrationsDir: "drizzle" });
```

See [docs/v4/features/schema-safety.md](https://github.com/SixthSummit/Ship/blob/dev/docs/v4/features/schema-safety.md)
for the release preset, the GitHub Action, and the adoption path.
