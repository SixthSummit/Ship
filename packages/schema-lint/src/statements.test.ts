import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./statements.js";

describe("splitSqlStatements", () => {
  it("splits on semicolons outside strings, identifiers, comments and dollar quotes", () => {
    const statements = splitSqlStatements(`
-- leading comment
CREATE TABLE "a;b" ("note" text DEFAULT 'x;y');
--> statement-breakpoint
/* block ; comment */
DO $$ BEGIN RAISE NOTICE 'one;two'; END $$;
INSERT INTO t VALUES ($tag$ a;b $tag$)
`);
    expect(statements.map((statement) => statement.code)).toEqual([
      `CREATE TABLE "a;b" ("note" text DEFAULT 'x;y')`,
      `DO $$ BEGIN RAISE NOTICE 'one;two'; END $$`,
      `INSERT INTO t VALUES ($tag$ a;b $tag$)`,
    ]);
    expect(statements[0]?.leadingComments).toEqual(["leading comment"]);
    expect(statements[1]?.leadingComments).toEqual(["> statement-breakpoint"]);
    expect(statements.map((statement) => statement.line)).toEqual([3, 6, 7]);
  });

  it("keeps escaped quotes inside strings", () => {
    const [statement] = splitSqlStatements(`UPDATE t SET name = 'it''s; fine'; SELECT 1;`);
    expect(statement?.code).toBe(`UPDATE t SET name = 'it''s; fine'`);
    expect(splitSqlStatements(`UPDATE t SET name = 'it''s; fine'; SELECT 1;`)).toHaveLength(2);
  });

  it("ignores empty statements", () => {
    expect(splitSqlStatements(";;\n  ;")).toEqual([]);
  });
});
