---
description: Generate a new Drizzle SQL migration via `npm run db:generate`. Reads `src/db/schema.ts`, diffs against the last migration in `src/db/migrations/`, and emits a numbered SQL file. Never hand-write migration SQL — the plugin's PreToolUse hook (`block-migration-edit.sh`) blocks it.
argument-hint: <migration-name>
allowed-tools: Bash, Read
---

Generate a Drizzle migration from the current schema:

```sh
npm run db:generate -- --name $1
```

This invokes `drizzle-kit generate`, which:

1. Reads `drizzle.config.ts` (canonical config — points at `src/db/schema.ts` + `src/db/migrations/`).
2. Compares the current schema source to the last applied migration's snapshot in `src/db/migrations/meta/_journal.json`.
3. Emits `src/db/migrations/NNNN_<kebab-of-name>.sql` plus an updated `meta/NNNN_snapshot.json`.

After generation:

1. **Read the emitted SQL** and verify it does what you expect — drizzle-kit can't infer column-rename intent (it'll emit DROP + ADD by default, losing data). For a rename, edit the SCHEMA SOURCE first to use a `pgTable` column name override, regenerate, and confirm the diff is now an `ALTER ... RENAME COLUMN`.
2. **Apply locally**: `npm run db:migrate` runs the new migration against the local Postgres (the same engine prod will run).
3. **Verify the schema**: `npm run db:studio` opens Drizzle Studio against the local DB; sanity-check the new shape.
4. Run the module's integration tests to verify the schema change didn't break the service layer:
   ```sh
   npx vitest run modules/<module>/
   ```

Why agents should never edit `src/db/migrations/*.sql` directly:

- The plugin's `block-migration-edit.sh` PreToolUse hook returns exit 2 on any Edit/Write to `src/db/migrations/**/*.sql`. The migration-as-derivation-of-schema invariant is what makes the schema-source the single source of truth. Hand-edited migrations diverge from snapshots; subsequent generations either silently break or generate destructive diffs.
- The right way to fix a migration is: edit the schema source → regenerate → review the new SQL.
- If you need a custom data backfill, write it as its own migration via `drizzle-kit generate --custom --name backfill-<description>`, which emits an empty SQL file you can fill in (the snapshot stays consistent).
