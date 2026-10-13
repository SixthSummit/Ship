import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __test,
  detectScaffoldTool,
  generateJob,
  generateMiddleware,
  generateModule,
  generateResource,
  generateSchema,
  generateService,
} from "./generate.js";

const {
  computeNames,
  applyNameSubstitutions,
  pluralize,
  singularize,
  computeMiddlewareNames,
  computeServiceNames,
  computeSchemaNames,
  computeJobNames,
  parseFieldSpec,
  renderSchemaColumns,
  renderCreateSchemaFields,
  renderUpdateSchemaFields,
} = __test;

describe("ship-api g module — name normalization", () => {
  it("normalizes the canonical accounts case", () => {
    expect(computeNames("accounts")).toEqual({
      namePlural: "accounts",
      nameSingular: "account",
      nameCamelPlural: "accounts",
      nameCamelSingular: "account",
      NamePlural: "Accounts",
      NameSingular: "Account",
      NAME_PLURAL: "ACCOUNTS",
      NAME_SINGULAR: "ACCOUNT",
    });
  });

  it("accepts a singular name and pluralizes it", () => {
    expect(computeNames("account").namePlural).toBe("accounts");
  });

  it("accepts PascalCase and converts to kebab-plural", () => {
    expect(computeNames("UserToken")).toMatchObject({
      namePlural: "user-tokens",
      nameSingular: "user-token",
      nameCamelPlural: "userTokens",
      nameCamelSingular: "userToken",
      NamePlural: "UserTokens",
      NameSingular: "UserToken",
      NAME_PLURAL: "USER_TOKENS",
      NAME_SINGULAR: "USER_TOKEN",
    });
  });

  it("idempotently re-pluralizes (`user-tokens` stays `user-tokens`, not `user-tokenses`)", () => {
    expect(computeNames("user-tokens").namePlural).toBe("user-tokens");
    expect(computeNames("user-token").namePlural).toBe("user-tokens");
  });

  it("accepts camelCase", () => {
    expect(computeNames("apiKey")).toMatchObject({
      namePlural: "api-keys",
      nameSingular: "api-key",
      nameCamelPlural: "apiKeys",
      NamePlural: "ApiKeys",
      NameSingular: "ApiKey",
    });
  });

  it("rejects empty / whitespace names", () => {
    expect(() => computeNames("")).toThrow(/empty/i);
    expect(() => computeNames("   ")).toThrow(/empty/i);
  });

  it("rejects names that don't start with a letter", () => {
    expect(() => computeNames("123abc")).toThrow(/invalid name/i);
    // Note: leading dashes get stripped during cleanup, so "--foo" ends
    // up valid as "foo". Reject names that ONLY contain non-letters.
    expect(() => computeNames("---")).toThrow(/empty|invalid/i);
  });

  describe("pluralization rules", () => {
    it("handles -s / -x / -z endings (es)", () => {
      expect(pluralize("class")).toBe("classes");
      expect(pluralize("box")).toBe("boxes");
      expect(pluralize("buzz")).toBe("buzzes");
    });

    it("handles consonant-y → ies", () => {
      expect(pluralize("party")).toBe("parties");
      expect(pluralize("body")).toBe("bodies");
    });

    it("preserves vowel-y (just adds s)", () => {
      expect(pluralize("key")).toBe("keys");
      expect(pluralize("day")).toBe("days");
    });

    it("handles consonant-o → oes", () => {
      expect(pluralize("hero")).toBe("heroes");
    });

    it("default: append s", () => {
      expect(pluralize("account")).toBe("accounts");
      expect(pluralize("user-token")).toBe("user-tokens");
    });
  });

  describe("singularization rules", () => {
    it("undoes pluralization", () => {
      expect(singularize("accounts")).toBe("account");
      expect(singularize("user-tokens")).toBe("user-token");
      expect(singularize("classes")).toBe("class");
      expect(singularize("parties")).toBe("party");
      expect(singularize("heroes")).toBe("hero");
    });
  });
});

describe("applyNameSubstitutions", () => {
  it("replaces every placeholder shape in a single pass", () => {
    const names = computeNames("user-tokens");
    const input =
      "{{namePlural}} / {{nameSingular}} / {{NamePlural}} / {{NameSingular}} / {{NAME_PLURAL}} / {{NAME_SINGULAR}}";
    expect(applyNameSubstitutions(input, names)).toBe(
      "user-tokens / user-token / UserTokens / UserToken / USER_TOKENS / USER_TOKEN",
    );
  });

  it("substitutes inside file paths too", () => {
    const names = computeNames("accounts");
    expect(applyNameSubstitutions("services/{{NameSingular}}Service.ts", names)).toBe(
      "services/AccountService.ts",
    );
  });

  it("repeats substitutions correctly across multiple occurrences", () => {
    const names = computeNames("accounts");
    expect(applyNameSubstitutions("{{namePlural}} {{namePlural}} {{namePlural}}", names)).toBe(
      "accounts accounts accounts",
    );
  });
});

describe("generateModule (end-to-end against real template)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-module-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("scaffolds the canonical accounts module shape", async () => {
    const targetRoot = path.join(tmp, "modules", "accounts");
    await generateModule("accounts", { targetRoot, silent: true });

    const written = await listFiles(targetRoot);
    // Expect the full canonical shape: module.json, schema, permissions,
    // service, routes, validation/schemas, index barrel.
    expect(written.sort()).toEqual([
      "index.ts",
      "module.json",
      "permissions.ts",
      "routes.ts",
      "schema.ts",
      "services/AccountService.ts",
      "validation/schemas.ts",
    ]);
  });

  it("substitutes placeholders in file *contents*", async () => {
    const targetRoot = path.join(tmp, "modules", "accounts");
    await generateModule("accounts", { targetRoot, silent: true });

    const routes = await readFile(path.join(targetRoot, "routes.ts"), "utf8");
    expect(routes).toContain('"/accounts"');
    expect(routes).toContain("ACCOUNTS_PERMISSIONS.read");
    expect(routes).toContain("AccountService");
    expect(routes).toContain("defineAccountsRoutes");
    // The scaffold emits the mount-at-root builder + its createModuleApp factory.
    expect(routes).toContain("buildAccountsApp");
    expect(routes).toContain('createModuleApp("accounts")');
    // Verify no raw placeholders survived.
    expect(routes).not.toContain("{{");
    expect(routes).not.toContain("}}");
  });

  it("substitutes placeholders in *file names*", async () => {
    const targetRoot = path.join(tmp, "modules", "user-tokens");
    await generateModule("user-tokens", { targetRoot, silent: true });

    const written = await listFiles(targetRoot);
    expect(written).toContain("services/UserTokenService.ts");
    expect(written).not.toContain("services/Service.ts");
  });

  it("normalizes weird-cased input ('UserToken' → 'user-tokens')", async () => {
    const targetRoot = path.join(tmp, "modules", "user-tokens");
    const result = await generateModule("UserToken", { targetRoot, silent: true });
    expect(result.names.namePlural).toBe("user-tokens");
    const manifest = JSON.parse(await readFile(path.join(targetRoot, "module.json"), "utf8"));
    expect(manifest.name).toBe("user-tokens");
  });

  it("module.json includes valid JSON", async () => {
    const targetRoot = path.join(tmp, "modules", "accounts");
    await generateModule("accounts", { targetRoot, silent: true });
    const manifest = JSON.parse(await readFile(path.join(targetRoot, "module.json"), "utf8"));
    expect(manifest.name).toBe("accounts");
    expect(manifest.version).toBe("0.1.0");
    expect(Array.isArray(manifest.requiredEnvVars)).toBe(true);
  });

  it("refuses to overwrite an existing non-empty target", async () => {
    const targetRoot = path.join(tmp, "modules", "accounts");
    await generateModule("accounts", { targetRoot, silent: true });

    await expect(generateModule("accounts", { targetRoot, silent: true })).rejects.toThrow(
      /not empty/,
    );
  });

  it("overwrites when --force is set", async () => {
    const targetRoot = path.join(tmp, "modules", "accounts");
    await generateModule("accounts", { targetRoot, silent: true });
    await expect(
      generateModule("accounts", {
        targetRoot,
        silent: true,
        force: true,
      }),
    ).resolves.toBeDefined();
  });

  it("schema file: kebab-case table NAME, camelCase JS identifier", async () => {
    const targetRoot = path.join(tmp, "modules", "user-tokens");
    await generateModule("user-tokens", { targetRoot, silent: true });
    const schema = await readFile(path.join(targetRoot, "schema.ts"), "utf8");
    // Table name (string arg to pgTable) stays kebab-case.
    expect(schema).toContain('pgTable("user-tokens"');
    // JS identifier must be camelCase — JS doesn't accept dashes.
    expect(schema).toContain("export const userTokens = pgTable");
    // PascalCase singular type alias.
    expect(schema).toContain("export type UserToken = typeof userTokens");
    expect(schema).toContain("export type NewUserToken = typeof userTokens");
  });
});

async function listFiles(root) {
  const out = [];
  await walk(root, root, (full, rel) => out.push(rel));
  return out;
}

async function walk(root, dir, visit) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, visit);
    } else {
      visit(full, path.relative(root, full));
    }
  }
}

// ─── In-module subcommand tests ───────────────────────────────────────

describe("computeMiddlewareNames", () => {
  it("kebab/camel/Pascal forms", () => {
    expect(computeMiddlewareNames("rate-limit-by-key")).toEqual({
      nameKebab: "rate-limit-by-key",
      nameCamel: "rateLimitByKey",
      NamePascal: "RateLimitByKey",
    });
  });

  it("normalizes camelCase input", () => {
    expect(computeMiddlewareNames("rateLimitByKey").nameKebab).toBe("rate-limit-by-key");
  });

  it("rejects empty / invalid names", () => {
    expect(() => computeMiddlewareNames("")).toThrow(/empty/i);
    expect(() => computeMiddlewareNames("123")).toThrow(/invalid/i);
  });
});

describe("computeServiceNames", () => {
  it("singularizes for service identifier", () => {
    expect(computeServiceNames("invoices")).toMatchObject({
      nameKebab: "invoice",
      NameSingular: "Invoice",
      nameCamelSingular: "invoice",
    });
  });

  it("preserves singular input", () => {
    expect(computeServiceNames("invoice").NameSingular).toBe("Invoice");
  });

  it("handles multi-word names", () => {
    expect(computeServiceNames("user-tokens")).toMatchObject({
      nameKebab: "user-token",
      NameSingular: "UserToken",
    });
  });
});

describe("computeSchemaNames", () => {
  it("pluralizes for table name", () => {
    expect(computeSchemaNames("invoice")).toMatchObject({
      namePlural: "invoices",
      nameSingular: "invoice",
      nameCamelPlural: "invoices",
      NamePascal: "Invoice",
    });
  });

  it("idempotent on plural input", () => {
    expect(computeSchemaNames("invoices").namePlural).toBe("invoices");
  });
});

describe("computeJobNames", () => {
  it("kebab/camel/Pascal forms", () => {
    expect(computeJobNames("send-invoice-email")).toEqual({
      nameKebab: "send-invoice-email",
      nameCamel: "sendInvoiceEmail",
      NamePascal: "SendInvoiceEmail",
    });
  });
});

describe("generateMiddleware (end-to-end)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-mw-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes a Hono middleware skeleton with the right factory signature", async () => {
    const targetPath = path.join(tmp, "src", "middleware", "rate-limit-by-key.ts");
    await generateMiddleware("rate-limit-by-key", { targetPath, silent: true });

    const contents = await readFile(targetPath, "utf8");
    expect(contents).toContain('import type { MiddlewareHandler } from "hono"');
    expect(contents).toContain("AppEnv");
    expect(contents).toContain("export interface RateLimitByKeyOptions");
    expect(contents).toContain(
      "export function rateLimitByKey(\n  opts: RateLimitByKeyOptions = {},\n): MiddlewareHandler<AppEnv>",
    );
    // No stray placeholders.
    expect(contents).not.toContain("{{");
    expect(contents).not.toContain("}}");
  });

  it("refuses to overwrite an existing file", async () => {
    const targetPath = path.join(tmp, "src", "middleware", "x.ts");
    await generateMiddleware("x", { targetPath, silent: true });
    await expect(generateMiddleware("x", { targetPath, silent: true })).rejects.toThrow(/exists/);
  });

  it("--force overwrites", async () => {
    const targetPath = path.join(tmp, "src", "middleware", "x.ts");
    await generateMiddleware("x", { targetPath, silent: true });
    await expect(
      generateMiddleware("x", { targetPath, silent: true, force: true }),
    ).resolves.toBeDefined();
  });
});

describe("generateService (end-to-end)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-svc-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function ensureModule(name) {
    const moduleDir = path.join(tmp, "src", "modules", `${name}s`);
    await mkdir(path.join(moduleDir, "services"), { recursive: true });
    return moduleDir;
  }

  it("writes a service skeleton extending DrizzleEntityService", async () => {
    const moduleDir = await ensureModule("billing");
    const targetPath = path.join(moduleDir, "services", "InvoiceService.ts");
    await generateService("invoice", {
      module: "billing",
      cwd: tmp,
      targetPath,
      silent: true,
    });

    const contents = await readFile(targetPath, "utf8");
    expect(contents).toContain("export class InvoiceService extends DrizzleEntityService");
    expect(contents).toContain('import { billings } from "../schema.js"');
    expect(contents).toContain("typeof billings");
    expect(contents).not.toContain("{{");
  });

  it("requires --module", async () => {
    await expect(generateService("x", { silent: true })).rejects.toThrow(/--module/i);
  });

  it("fails when the module directory doesn't exist", async () => {
    await expect(
      generateService("invoice", {
        module: "nonexistent",
        cwd: tmp,
        silent: true,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe("generateSchema (end-to-end)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-sch-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function ensureModule(name) {
    const moduleDir = path.join(tmp, "src", "modules", `${name}s`);
    await mkdir(path.join(moduleDir, "schemas"), { recursive: true });
    return moduleDir;
  }

  it("writes a pgTable skeleton with kebab table name + camel JS identifier", async () => {
    const moduleDir = await ensureModule("billing");
    const targetPath = path.join(moduleDir, "schemas", "invoices.ts");
    await generateSchema("invoice", {
      module: "billing",
      cwd: tmp,
      targetPath,
      silent: true,
    });

    const contents = await readFile(targetPath, "utf8");
    // Idempotent pluralization: invoice → invoices.
    expect(contents).toContain('pgTable("invoices"');
    expect(contents).toContain("export const invoices = pgTable");
    expect(contents).toContain("export type Invoice = typeof invoices");
    expect(contents).toContain("export type NewInvoice = typeof invoices");
    expect(contents).not.toContain("{{");
  });
});

describe("generateJob (end-to-end)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-job-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function ensureModule(name) {
    const moduleDir = path.join(tmp, "src", "modules", `${name}s`);
    await mkdir(path.join(moduleDir, "jobs"), { recursive: true });
    return moduleDir;
  }

  it("writes a BullMQ job stub with payloadSchema + processor", async () => {
    const moduleDir = await ensureModule("billing");
    const targetPath = path.join(moduleDir, "jobs", "send-invoice-email.job.ts");
    await generateJob("send-invoice-email", {
      module: "billing",
      cwd: tmp,
      targetPath,
      silent: true,
    });

    const contents = await readFile(targetPath, "utf8");
    expect(contents).toContain("export const sendInvoiceEmailPayloadSchema = z.object");
    expect(contents).toContain("export type SendInvoiceEmailPayload =");
    expect(contents).toContain("export const sendInvoiceEmailJob = {");
    expect(contents).toContain('queue: "billings"');
    expect(contents).toContain('name: "send-invoice-email"');
    expect(contents).toContain("export default sendInvoiceEmailJob");
    expect(contents).not.toContain("{{");
  });

  it("requires --module", async () => {
    await expect(generateJob("x", { silent: true })).rejects.toThrow(/--module/i);
  });
});

// Suppress unused-import warning when only some helpers are used.
void writeFile;

// ─── g resource tests ─────────────────────────────────────────────────

describe("parseFieldSpec", () => {
  it("parses a single required field", () => {
    expect(parseFieldSpec("title:string")).toEqual([
      { name: "title", type: "string", nullable: false, known: true },
    ]);
  });

  it("parses multiple comma-separated fields", () => {
    const fields = parseFieldSpec("title:string,body:text,published:boolean");
    expect(fields).toHaveLength(3);
    expect(fields.map((f) => f.name)).toEqual(["title", "body", "published"]);
  });

  it("recognizes the `?` nullable suffix", () => {
    const [f] = parseFieldSpec("publishedAt:timestamp?");
    expect(f.nullable).toBe(true);
    expect(f.type).toBe("timestamp");
  });

  it("supports all documented types", () => {
    const fields = parseFieldSpec(
      "a:string,b:text,c:integer,d:bigint,e:boolean,f:timestamp,g:uuid,h:json",
    );
    for (const f of fields) {
      expect(f.known, `${f.name}:${f.type}`).toBe(true);
    }
  });

  it("flags unknown types so the renderer emits a TODO marker", () => {
    const [f] = parseFieldSpec("weird:unknownType");
    expect(f.known).toBe(false);
  });

  it("returns [] for empty input", () => {
    expect(parseFieldSpec("")).toEqual([]);
    expect(parseFieldSpec("   ")).toEqual([]);
  });

  it("rejects malformed entries (no colon)", () => {
    expect(() => parseFieldSpec("title")).toThrow(/malformed/i);
  });

  it("rejects invalid field names (non-camelCase)", () => {
    expect(() => parseFieldSpec("123abc:string")).toThrow(/invalid field name/i);
    expect(() => parseFieldSpec("with-dash:string")).toThrow(/invalid field name/i);
  });

  it("converts camelCase field names to snake_case column names (verified via rendered output)", () => {
    const fields = parseFieldSpec("publishedAt:timestamp,authorId:uuid");
    const cols = renderSchemaColumns(fields);
    expect(cols).toContain('"published_at"');
    expect(cols).toContain('"author_id"');
  });
});

describe("renderSchemaColumns", () => {
  it("emits varchar with length for string", () => {
    const out = renderSchemaColumns(parseFieldSpec("title:string"));
    expect(out).toContain('title: varchar("title", { length: 255 }).notNull()');
  });

  it("emits text without length for text", () => {
    const out = renderSchemaColumns(parseFieldSpec("body:text"));
    expect(out).toContain('body: text("body").notNull()');
  });

  it("emits timestamp with withTimezone:true", () => {
    const out = renderSchemaColumns(parseFieldSpec("publishedAt:timestamp"));
    expect(out).toContain(
      'publishedAt: timestamp("published_at", { withTimezone: true }).notNull()',
    );
  });

  it("emits uuid for uuid", () => {
    const out = renderSchemaColumns(parseFieldSpec("authorId:uuid"));
    expect(out).toContain('authorId: uuid("author_id").notNull()');
  });

  it("emits integer for integer + number", () => {
    const out1 = renderSchemaColumns(parseFieldSpec("count:integer"));
    expect(out1).toContain('count: integer("count").notNull()');
    const out2 = renderSchemaColumns(parseFieldSpec("count:number"));
    expect(out2).toContain('count: integer("count").notNull()');
  });

  it("emits bigint with mode:'number'", () => {
    const out = renderSchemaColumns(parseFieldSpec("eventNumber:bigint"));
    expect(out).toContain('eventNumber: bigint("event_number", { mode: "number" }).notNull()');
  });

  it("emits jsonb with $type<...>() for json", () => {
    const out = renderSchemaColumns(parseFieldSpec("metadata:json"));
    expect(out).toContain('metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull()');
  });

  it("omits .notNull() for nullable fields", () => {
    const out = renderSchemaColumns(parseFieldSpec("nickname:string?"));
    expect(out).toContain('nickname: varchar("nickname", { length: 255 }),');
    expect(out).not.toMatch(/nickname:.*notNull/);
  });

  it("emits TODO marker for unknown types", () => {
    const out = renderSchemaColumns(parseFieldSpec("weird:unknownType"));
    expect(out).toContain("TODO[ship-api]");
    expect(out).toContain("unknownType");
  });
});

describe("renderCreateSchemaFields / renderUpdateSchemaFields", () => {
  it("create: required fields use the bare zod type", () => {
    const out = renderCreateSchemaFields(parseFieldSpec("title:string"));
    expect(out).toContain("title: z.string(),");
  });

  it("create: nullable fields use .optional()", () => {
    const out = renderCreateSchemaFields(parseFieldSpec("nickname:string?"));
    expect(out).toContain("nickname: z.string().optional(),");
  });

  it("update: every field is optional, nullables also nullable", () => {
    const out = renderUpdateSchemaFields(parseFieldSpec("title:string,nickname:string?"));
    expect(out).toContain("title: z.string().optional(),");
    expect(out).toContain("nickname: z.string().nullable().optional(),");
  });

  it("zod: timestamp uses z.coerce.date()", () => {
    const out = renderCreateSchemaFields(parseFieldSpec("publishedAt:timestamp"));
    expect(out).toContain("publishedAt: z.coerce.date(),");
  });

  it("zod: uuid uses z.string().uuid()", () => {
    const out = renderCreateSchemaFields(parseFieldSpec("authorId:uuid"));
    expect(out).toContain("authorId: z.string().uuid(),");
  });
});

describe("generateResource (end-to-end)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-resource-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("produces a full module shape with the supplied fields wired into schema + validation", async () => {
    const targetRoot = path.join(tmp, "modules", "posts");
    await generateResource("post", {
      targetRoot,
      fields: "title:string,body:text,published:boolean,publishedAt:timestamp?,authorId:uuid",
      silent: true,
    });

    // Schema reflects the field types + nullability.
    const schema = await readFile(path.join(targetRoot, "schema.ts"), "utf8");
    expect(schema).toContain('title: varchar("title", { length: 255 }).notNull()');
    expect(schema).toContain('body: text("body").notNull()');
    expect(schema).toContain('published: boolean("published").notNull()');
    expect(schema).toContain('publishedAt: timestamp("published_at", { withTimezone: true }),');
    expect(schema).not.toMatch(/publishedAt:.*notNull/);
    expect(schema).toContain('authorId: uuid("author_id").notNull()');

    // Imports updated to match the types used.
    expect(schema).toMatch(
      /import \{[^}]*boolean[^}]*pgTable[^}]*text[^}]*timestamp[^}]*uuid[^}]*varchar[^}]*\} from "drizzle-orm\/pg-core"/,
    );

    // Validation has create + update with proper required/optional + nullable.
    const validation = await readFile(path.join(targetRoot, "validation", "schemas.ts"), "utf8");
    expect(validation).toContain("title: z.string(),");
    expect(validation).toContain("authorId: z.string().uuid(),");
    expect(validation).toContain("publishedAt: z.coerce.date().optional(),");
    // Update schema has every field optional.
    expect(validation).toContain("title: z.string().optional(),");
    expect(validation).toContain("publishedAt: z.coerce.date().nullable().optional(),");

    // Default `name` placeholder must be gone.
    expect(schema).not.toMatch(/^\s+name: varchar\("name"/m);
    expect(validation).not.toMatch(/name: z\.string\(\)\.min\(1\)\.max\(200\)/);
  });

  it("requires --fields", async () => {
    await expect(
      generateResource("post", {
        targetRoot: path.join(tmp, "modules", "posts"),
        silent: true,
      }),
    ).rejects.toThrow(/--fields/i);
  });

  it("rejects malformed --fields", async () => {
    await expect(
      generateResource("post", {
        targetRoot: path.join(tmp, "modules", "posts"),
        fields: "no-colon-here",
        silent: true,
      }),
    ).rejects.toThrow(/malformed|invalid/i);
  });
});

// ─── scaffold tool detection (delivery-metrics M6 by-tool split) ──────

describe("detectScaffoldTool", () => {
  it("prefers an explicit opts.tool over everything", () => {
    expect(detectScaffoldTool({ tool: "x" }, { CLAUDECODE: "1" })).toBe("x");
  });
  it("honors the SHIP_API_SCAFFOLD_TOOL override above env markers", () => {
    expect(detectScaffoldTool({}, { SHIP_API_SCAFFOLD_TOOL: "cursor", CLAUDECODE: "1" })).toBe(
      "cursor",
    );
  });
  it("detects Claude Code via CLAUDECODE", () => {
    expect(detectScaffoldTool({}, { CLAUDECODE: "1" })).toBe("claude-code");
  });
  it("detects Cursor via CURSOR_TRACE_ID (best-effort)", () => {
    expect(detectScaffoldTool({}, { CURSOR_TRACE_ID: "abc" })).toBe("cursor");
  });
  it("falls back to 'cli' when no marker is present", () => {
    expect(detectScaffoldTool({}, {})).toBe("cli");
  });
});

// ─── scaffold provenance (delivery-metrics breadcrumb) ────────────────

describe("scaffold metadata stamping (delivery-metrics breadcrumb)", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-g-scaffold-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function readManifest(targetRoot) {
    return JSON.parse(await readFile(path.join(targetRoot, "module.json"), "utf8"));
  }

  it("records generator, name, timestamp, and framework version in module.json", async () => {
    const targetRoot = path.join(tmp, "modules", "accounts");
    await generateModule("accounts", {
      targetRoot,
      silent: true,
      now: "2026-05-30T12:00:00.000Z",
      frameworkVersion: "9.9.9-test",
      tool: "test-tool",
    });
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold).toEqual({
      generator: "module",
      name: "accounts",
      at: "2026-05-30T12:00:00.000Z",
      frameworkVersion: "9.9.9-test",
      tool: "test-tool",
    });
  });

  it("records the scaffolding tool from opts.tool", async () => {
    const targetRoot = path.join(tmp, "modules", "ledgers");
    await generateModule("ledger", {
      targetRoot,
      silent: true,
      frameworkVersion: "9.9.9-test",
      tool: "claude-code",
    });
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold.tool).toBe("claude-code");
  });

  it("falls back to the SHIP_API_SCAFFOLD_TOOL env override when opts.tool is absent", async () => {
    const targetRoot = path.join(tmp, "modules", "invoices");
    const prev = process.env.SHIP_API_SCAFFOLD_TOOL;
    process.env.SHIP_API_SCAFFOLD_TOOL = "cursor";
    try {
      await generateModule("invoice", { targetRoot, silent: true, frameworkVersion: "9.9.9-test" });
    } finally {
      if (prev === undefined) delete process.env.SHIP_API_SCAFFOLD_TOOL;
      else process.env.SHIP_API_SCAFFOLD_TOOL = prev;
    }
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold.tool).toBe("cursor");
  });

  it("records the canonical namePlural even for weird-cased input", async () => {
    const targetRoot = path.join(tmp, "modules", "user-tokens");
    await generateModule("UserToken", {
      targetRoot,
      silent: true,
      now: "2026-05-30T12:00:00.000Z",
      frameworkVersion: "9.9.9-test",
    });
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold.name).toBe("user-tokens");
  });

  it("marks resource-generated modules with generator 'resource'", async () => {
    const targetRoot = path.join(tmp, "modules", "posts");
    await generateResource("post", {
      targetRoot,
      fields: "title:string",
      silent: true,
      now: "2026-05-30T12:00:00.000Z",
      frameworkVersion: "9.9.9-test",
    });
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold.generator).toBe("resource");
    expect(manifest.scaffold.name).toBe("posts");
  });

  it("accepts a Date for `now` and serializes it to ISO-8601", async () => {
    const targetRoot = path.join(tmp, "modules", "widgets");
    await generateModule("widget", {
      targetRoot,
      silent: true,
      now: new Date("2026-01-02T03:04:05.000Z"),
      frameworkVersion: "9.9.9-test",
    });
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold.at).toBe("2026-01-02T03:04:05.000Z");
  });

  it("defaults to a real ISO timestamp + resolved framework version when not injected", async () => {
    const targetRoot = path.join(tmp, "modules", "gadgets");
    await generateModule("gadget", { targetRoot, silent: true });
    const manifest = await readManifest(targetRoot);
    expect(manifest.scaffold.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(manifest.scaffold.at))).toBe(false);
    expect(typeof manifest.scaffold.frameworkVersion).toBe("string");
    expect(manifest.scaffold.frameworkVersion.length).toBeGreaterThan(0);
    expect(manifest.scaffold.generator).toBe("module");
  });
});
