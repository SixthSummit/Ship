---
name: ship-drizzle-migrations
description: Use when working with Drizzle migrations in a ShipAPI v4 codebase — schema edits in `modules/**/schema.ts`, files under `src/db/migrations/`, or any time the user mentions "generate migration", "db:push", "db:baseline", "drizzle-kit". Loads the migration rules: never hand-edit SQL, always go through drizzle-kit, baseline pattern for v3 holdouts.
---

# ShipAPI v4 — Drizzle migrations

> **Source**: `.cursor/rules/api.mdc` ("never write migrations manually" + the v4 plan §B migration tooling section).

## Tools (consumer-app scripts)

| Script         | What it does                                                                                                         | When to run                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `db:push`      | Push the live schema to dev DB without writing a migration file                                                      | Iterating on schema during dev — not for prod  |
| `db:generate`  | Diff the schema vs the migration history, emit a new SQL file                                                        | After every schema edit, before commit         |
| `db:migrate`   | Apply pending migration files to the target DB                                                                       | At deploy time / boot time                     |
| `db:baseline`  | One-shot for v3 holdouts: introspect the live schema, mark a `0000_baseline` migration as applied without re-running | First time you adopt v4 against an existing DB |
| `db:reconcile` | Diff introspected schema vs codemod-emitted schema; report column / index mismatches for manual reconciliation       | When v3 entity files diverged from prod schema |
| `db:studio`    | Open Drizzle Studio web UI                                                                                           | Local exploration / debugging                  |

## Hard rules

- **Never hand-edit `src/db/migrations/*.sql`.** The next `db:generate` will produce drift; the file you edited gets overwritten or breaks history. If the generator produces something wrong, fix the schema source and re-generate.

- **Never run `db:push` against prod.** It bypasses the migration history and will silently desync envs. Use `db:generate` + `db:migrate` for prod path.

- **Always commit the schema edit + the generated migration in the same commit.** Splitting them turns intermediate commits into broken builds.

## Common flows

### Add a column to an existing table

```ts
// modules/billing/schema.ts
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // ...
  + canceledAt: timestamp("canceled_at", { withTimezone: true }),
  ...baseFields,
});
```

```sh
npm run db:generate -- --name add_canceled_at_to_subscriptions
# Creates src/db/migrations/0042_add_canceled_at_to_subscriptions.sql
git add modules/billing/schema.ts src/db/migrations/0042_*.sql
git commit -m "feat(billing): add canceledAt column to subscriptions"
```

### Add a new table (new module)

After `ship-api g module <name>` writes `modules/<name>/schema.ts`, customize it, then:

```sh
npm run db:generate -- --name create_<name>_table
```

Compose the table into the consumer's schema before running migrate:

```ts
// src/index.ts (or wherever createApp() is composed)
import { accountsSchema } from "./modules/accounts";
import { invoices } from "billing";
const schema = { ...accountsSchema, invoices };
const app = createApp({ schema });
```

### Rename a column (audit-column rename, etc.)

drizzle-kit can't infer rename intent — it'll DROP + ADD by default which loses data. Use the rename helper:

```sh
npm run db:generate -- --name rename_xxx_to_yyy
# When prompted, confirm "yyy" is a rename of "xxx" — drizzle-kit emits ALTER TABLE RENAME
```

### Adopting v4 against a v3 database

```sh
# 1. Make sure your v4 schema files match the live schema (run migrate-orm --write)
ship-api migrate-orm modules/<name>/entity --write

# 2. Mark the baseline so drizzle-kit doesn't try to recreate the schema
npm run db:baseline

# 3. Verify nothing's drifted
npm run db:reconcile
```

## Constraints to know

- Partial indexes use `.where(sql\`...\`)`chained on`index(...)`. The drain-query pattern in `modules/outbox/schema.ts` is the canonical example.

- pgEnum types must be defined as separate exports before the table that uses them (`pgEnum("name", ["a", "b"])`). The migration creates the enum type as a separate DDL statement.

- FKs use `references(() => otherTable.id, { onDelete: "cascade" | "set null" | "no action" })`. The default is `no action` — be explicit when you want cascade or null-on-delete.

- `...baseFields` spreads the audit columns (`createdAt`, `updatedAt`, `deletedAt`, `createdBy`, `updatedBy`). Don't redeclare them per-table.
