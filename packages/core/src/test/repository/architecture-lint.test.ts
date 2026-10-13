import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

async function lintText(source: string, filePath: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source, { filePath });
  return result.messages.map(({ ruleId }) => ruleId);
}

describe("architecture lint boundaries", () => {
  it("rejects transport input that bypasses registered validation", async () => {
    const rules = await lintText(
      "export async function route(c) { return c.req.json(); }",
      "modules/example/routes.ts",
    );

    expect(rules).toContain("no-restricted-syntax");
  });

  it("accepts transport input read through the validated request contract", async () => {
    const rules = await lintText(
      'export function route(c) { return c.req.valid("json"); }',
      "modules/example/routes.ts",
    );

    expect(rules).toEqual([]);
  });

  it("rejects ORM value imports outside the data-access boundary", async () => {
    const rules = await lintText(
      'import { eq } from "drizzle-orm"; export const compare = eq;',
      "modules/example/services/ExampleService.ts",
    );

    expect(rules).toContain("@typescript-eslint/no-restricted-imports");
  });

  it("accepts ORM type imports and database-boundary implementations", async () => {
    const typeRules = await lintText(
      'import type { SQL } from "drizzle-orm"; export type Query = SQL;',
      "modules/example/services/ExampleService.ts",
    );
    const databaseRules = await lintText(
      'import { eq } from "drizzle-orm"; export const compare = eq;',
      "packages/core/src/app/db/example.ts",
    );

    expect(typeRules).toEqual([]);
    expect(databaseRules).toEqual([]);
  });
});
