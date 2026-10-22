import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureSchemaSnapshot,
  checkSchemaSnapshot,
  diffSchemaSnapshots,
  formatSnapshotDifferences,
  readSnapshotFile,
  type SchemaSnapshot,
  SnapshotFileError,
  type SnapshotQueryable,
  serializeSnapshot,
  writeSchemaSnapshot,
} from "./snapshot.js";

/** Canned catalog rows keyed by the first word of the query that reads them. */
function fakeCatalog(
  overrides: Partial<
    Record<"tables" | "columns" | "constraints" | "indexes" | "enums", unknown[]>
  > = {},
): SnapshotQueryable {
  const rows = {
    tables: [
      { schema: "public", name: "orders" },
      { schema: "public", name: "__drizzle_migrations" },
    ],
    columns: [
      {
        schema: "public",
        table: "orders",
        name: "id",
        type: "uuid",
        not_null: true,
        default_expression: "gen_random_uuid()",
        identity: "",
        generated: "",
      },
      {
        schema: "public",
        table: "orders",
        name: "total",
        type: "integer",
        not_null: false,
        default_expression: null,
        identity: "",
        generated: "",
      },
      {
        schema: "public",
        table: "orders",
        name: "seq",
        type: "integer",
        not_null: true,
        default_expression: null,
        identity: "a",
        generated: "",
      },
    ],
    constraints: [
      {
        schema: "public",
        table: "orders",
        name: "orders_pkey",
        type: "p",
        definition: "PRIMARY KEY (id)",
      },
    ],
    indexes: [
      {
        schema: "public",
        table: "orders",
        name: "orders_pkey",
        definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
      },
    ],
    enums: [{ schema: "public", name: "status", values: ["open", "done"] }],
    ...overrides,
  };
  return {
    query: async (text: string) => {
      if (text.includes("pg_attribute"))
        return { rows: rows.columns as Array<Record<string, unknown>> };
      if (text.includes("pg_constraint"))
        return { rows: rows.constraints as Array<Record<string, unknown>> };
      if (text.includes("pg_indexes"))
        return { rows: rows.indexes as Array<Record<string, unknown>> };
      if (text.includes("pg_enum")) return { rows: rows.enums as Array<Record<string, unknown>> };
      return { rows: rows.tables as Array<Record<string, unknown>> };
    },
  };
}

describe("captureSchemaSnapshot", () => {
  it("builds a canonical snapshot and excludes the migrations ledger", async () => {
    const snapshot = await captureSchemaSnapshot(fakeCatalog());
    expect(snapshot).toEqual({
      schemaVersion: 1,
      schemas: ["public"],
      enums: [{ schema: "public", name: "status", values: ["open", "done"] }],
      tables: [
        {
          schema: "public",
          name: "orders",
          columns: [
            { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
            { name: "seq", type: "integer", nullable: false, default: null, identity: "a" },
            { name: "total", type: "integer", nullable: true, default: null },
          ],
          constraints: [{ name: "orders_pkey", type: "p", definition: "PRIMARY KEY (id)" }],
          indexes: [
            {
              name: "orders_pkey",
              definition: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
            },
          ],
        },
      ],
    });
    expect(serializeSnapshot(snapshot)).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
  });
});

describe("diffSchemaSnapshots", () => {
  it("reports added, removed and changed objects", async () => {
    const expected = await captureSchemaSnapshot(fakeCatalog());
    const actual = await captureSchemaSnapshot(
      fakeCatalog({
        columns: [
          {
            schema: "public",
            table: "orders",
            name: "id",
            type: "uuid",
            not_null: true,
            default_expression: "gen_random_uuid()",
            identity: "",
            generated: "",
          },
          {
            schema: "public",
            table: "orders",
            name: "total",
            type: "bigint",
            not_null: true,
            default_expression: null,
            identity: "",
            generated: "",
          },
          {
            schema: "public",
            table: "orders",
            name: "note",
            type: "text",
            not_null: false,
            default_expression: null,
            identity: "",
            generated: "",
          },
        ],
        enums: [{ schema: "public", name: "status", values: ["open", "done", "void"] }],
        indexes: [],
      }),
    );
    const differences = diffSchemaSnapshots(expected, actual);
    expect(differences.map((difference) => `${difference.kind} ${difference.path}`)).toEqual([
      "changed enum public.status.values",
      "removed table public.orders.column seq",
      "changed table public.orders.column total.type",
      "changed table public.orders.column total.nullable",
      "added table public.orders.column note",
      "removed table public.orders.index orders_pkey",
    ]);
    const report = formatSnapshotDifferences({
      command: "snapshot-check",
      ok: false,
      exitCode: 1,
      snapshotPath: "schema.snapshot.json",
      differences,
    });
    expect(report).toContain(`~ table public.orders.column total.type: "integer" -> "bigint"`);
    expect(report).toContain("+ table public.orders.column note");
    expect(report).toContain("- table public.orders.index orders_pkey");
  });

  it("is empty for identical snapshots", async () => {
    const snapshot = await captureSchemaSnapshot(fakeCatalog());
    expect(diffSchemaSnapshots(snapshot, structuredClone(snapshot))).toEqual([]);
  });
});

describe("snapshot files", () => {
  it("writes, reads back and checks a snapshot", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-"));
    const snapshotPath = resolve(directory, "schema.snapshot.json");
    const written = await writeSchemaSnapshot({ client: fakeCatalog(), snapshotPath });
    expect(await readFile(snapshotPath, "utf8")).toBe(serializeSnapshot(written));
    expect(await readSnapshotFile(snapshotPath)).toEqual(written);
    const ok = await checkSchemaSnapshot({ client: fakeCatalog(), snapshotPath });
    expect(ok.ok).toBe(true);
    expect(formatSnapshotDifferences(ok)).toContain("matches");
    const drift = await checkSchemaSnapshot({ client: fakeCatalog({ indexes: [] }), snapshotPath });
    expect(drift.ok).toBe(false);
    expect(drift.exitCode).toBe(1);
  });

  it("rejects missing or malformed snapshot files", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "ship-schema-lint-"));
    await expect(readSnapshotFile(resolve(directory, "missing.json"))).rejects.toThrow(
      SnapshotFileError,
    );
    const malformed = resolve(directory, "malformed.json");
    await writeFile(malformed, "{", "utf8");
    await expect(readSnapshotFile(malformed)).rejects.toThrow(/not valid JSON/u);
    const wrongShape = resolve(directory, "wrong.json");
    await writeFile(
      wrongShape,
      JSON.stringify({ schemaVersion: 2 } satisfies Partial<SchemaSnapshot>),
      "utf8",
    );
    await expect(readSnapshotFile(wrongShape)).rejects.toThrow(/schemaVersion 1/u);
  });
});
