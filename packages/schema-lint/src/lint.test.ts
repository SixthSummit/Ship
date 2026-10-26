import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AllowlistError, parseAllowlist } from "./allowlist.js";
import {
  formatLintReport,
  lintMigrationSql,
  lintMigrations,
  MigrationSourceError,
  readMigrationsDirectory,
  SCHEMA_LINT_EXIT,
} from "./lint.js";
import { RECIPES, RULE_IDS } from "./rules.js";

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const base = await readFile(resolve(fixtures, "rules", "base.sql"), "utf8");

async function lintRuleFixture(ruleId: string, variant: "fail" | "pass") {
  const sql = await readFile(resolve(fixtures, "rules", ruleId, `${variant}.sql`), "utf8");
  return lintMigrationSql([
    { tag: "0000_init", sql: base },
    { tag: `0001_${variant}`, sql },
  ]);
}

describe("rule fixtures", () => {
  for (const ruleId of RULE_IDS) {
    it(`${ruleId}: fail fixture reports exactly that rule with its recipe`, async () => {
      const result = await lintRuleFixture(ruleId, "fail");
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(SCHEMA_LINT_EXIT.findings);
      expect(result.findings.map((finding) => finding.ruleId)).toEqual([ruleId]);
      expect(result.findings[0]?.migration).toBe("0001_fail");
      expect(result.findings[0]?.recipe).toEqual(RECIPES[ruleId]);
      expect(formatLintReport(result)).toContain(`[${ruleId}]`);
    });

    it(`${ruleId}: pass fixture is clean`, async () => {
      const result = await lintRuleFixture(ruleId, "pass");
      expect(result.findings).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(SCHEMA_LINT_EXIT.ok);
    });
  }

  it("does not flag the baseline migration that creates the tables", () => {
    const result = lintMigrationSql([{ tag: "0000_init", sql: base }]);
    expect(result.findings).toEqual([]);
  });

  it("handles schema-qualified and unquoted identifiers", () => {
    const result = lintMigrationSql([
      { tag: "0000_init", sql: `CREATE TABLE public.orders (id int);` },
      {
        tag: "0001_change",
        sql: `ALTER TABLE "public"."orders" DROP COLUMN IF EXISTS id; CREATE INDEX ON ORDERS (id);`,
      },
    ]);
    expect(
      result.findings.map((finding) => [finding.ruleId, finding.table, finding.column]),
    ).toEqual([
      ["column-drop", "public.orders", "id"],
      ["non-concurrent-index", "public.orders", undefined],
    ]);
  });

  it("treats tables it never saw created as existing", () => {
    const result = lintMigrationSql([
      { tag: "0001_change", sql: `CREATE INDEX "i" ON "unknown" ("a");` },
    ]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["non-concurrent-index"]);
  });
});

describe("allowlist", () => {
  const unsafe = [
    { tag: "0000_init", sql: base },
    { tag: "0001_drop", sql: `ALTER TABLE "orders" DROP COLUMN "legacy_flag";` },
  ];

  it("suppresses a finding with a justified file entry and reports it as allowed", () => {
    const allowlist = parseAllowlist({
      allow: [
        {
          migration: "0001_drop",
          rule: "column-drop",
          justification: "readers removed in 2026.10.1",
        },
      ],
    });
    const result = lintMigrationSql(unsafe, { allowlist });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0]?.source).toBe("file");
    expect(formatLintReport(result)).toContain("allowed 0001_drop.sql");
  });

  it("suppresses a finding with an inline directive", () => {
    const result = lintMigrationSql([
      unsafe[0] as (typeof unsafe)[number],
      {
        tag: "0001_drop",
        sql: `-- ship-schema-lint: allow column-drop readers removed in 2026.10.1\nALTER TABLE "orders" DROP COLUMN "legacy_flag";`,
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.allowed[0]?.source).toBe("inline");
    expect(result.allowed[0]?.justification).toBe("readers removed in 2026.10.1");
  });

  it("rejects an inline directive without a justification", () => {
    expect(() =>
      lintMigrationSql([
        {
          tag: "0001_drop",
          sql: `-- ship-schema-lint: allow column-drop\nALTER TABLE "orders" DROP COLUMN "x";`,
        },
      ]),
    ).toThrow(AllowlistError);
  });

  it("rejects file entries without justification, with unknown rules, or without a migration", () => {
    expect(() =>
      parseAllowlist({ allow: [{ migration: "a", rule: "column-drop", justification: "ok" }] }),
    ).toThrow(/justification is required/u);
    expect(() =>
      parseAllowlist({
        allow: [{ migration: "a", rule: "nope", justification: "long enough text" }],
      }),
    ).toThrow(/rule must be one of/u);
    expect(() =>
      parseAllowlist({ allow: [{ rule: "column-drop", justification: "long enough text" }] }),
    ).toThrow(/migration must be/u);
    expect(() => parseAllowlist([])).toThrow(AllowlistError);
    expect(() => parseAllowlist({ allow: "x" })).toThrow(/allow must be an array/u);
    expect(() => parseAllowlist({})).toThrow(/allow must be an array/u);
  });

  it("fails on a stale allowlist entry that matches nothing", () => {
    const allowlist = parseAllowlist({
      allow: [
        { migration: "0001_drop", rule: "table-drop", justification: "this entry is stale now" },
      ],
    });
    const result = lintMigrationSql(unsafe, { allowlist });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["column-drop"]);
    expect(result.unusedAllowlist).toHaveLength(1);
    expect(formatLintReport(result)).toContain("matched nothing");
  });

  it("only reports findings after the baseline while still tracking table state", () => {
    const migrations = [
      { tag: "0000_init", sql: base },
      { tag: "0001_old_drop", sql: `ALTER TABLE "orders" DROP COLUMN "legacy_flag";` },
      { tag: "0002_new_index", sql: `CREATE INDEX "i" ON "orders" ("created_at");` },
    ];
    const viaOption = lintMigrationSql(migrations, { since: "0001_old_drop" });
    expect(viaOption.findings.map((finding) => finding.ruleId)).toEqual(["non-concurrent-index"]);
    expect(viaOption.linted).toBe(1);
    const viaBaseline = lintMigrationSql(migrations, {
      allowlist: parseAllowlist({ baseline: "0001_old_drop", allow: [] }),
    });
    expect(viaBaseline.findings.map((finding) => finding.ruleId)).toEqual(["non-concurrent-index"]);
    expect(() => lintMigrationSql(migrations, { since: "9999_missing" })).toThrow(
      MigrationSourceError,
    );
  });
});

describe("readMigrationsDirectory", () => {
  it("orders by the journal and lints the unsafe fixture", async () => {
    const migrations = await readMigrationsDirectory(resolve(fixtures, "migrations", "unsafe"));
    expect(migrations.map((migration) => migration.tag)).toEqual([
      "0000_init",
      "0001_retire_legacy",
    ]);
    const result = await lintMigrations({
      migrationsDir: resolve(fixtures, "migrations", "unsafe"),
      allowlistPath: resolve(fixtures, "migrations", "unsafe", "allowlist.json"),
    });
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(["non-concurrent-index"]);
    expect(result.allowed.map((allowed) => [allowed.finding.ruleId, allowed.source])).toEqual([
      ["column-drop", "inline"],
      ["column-rename", "file"],
    ]);
    expect(result.migrationsDir).toBe(resolve(fixtures, "migrations", "unsafe"));
  });

  it("passes the safe fixture", async () => {
    const result = await lintMigrations({ migrationsDir: resolve(fixtures, "migrations", "safe") });
    expect(result.ok).toBe(true);
    expect(result.linted).toBe(2);
  });

  it("fails on a missing directory or a journal that lists a missing file", async () => {
    await expect(readMigrationsDirectory(resolve(fixtures, "missing"))).rejects.toThrow(
      MigrationSourceError,
    );
  });
});
