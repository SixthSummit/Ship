import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/**
 * `ship-api g <type> <name>` — framework component generators per plan §C.
 *
 * This file ships **`g module <name>`** — the foundational generator that
 * scaffolds a complete v4 module (schema + service + routes + validation
 * + permissions + index barrel) from the canonical template at
 * `packages/core/cli/templates/module/`. The template was extracted from
 * the `modules/accounts/` port (the canonical reference).
 *
 * Future subcommands (`g resource`, `g service`, `g schema`, `g middleware`,
 * `g job`, `g test`) layer on the same template-substitution mechanism.
 *
 * Substitution placeholders:
 *
 *   {{namePlural}}        kebab-case-plural ("accounts", "user-tokens") — for paths + string literals
 *   {{nameSingular}}      kebab-case-singular ("account", "user-token")
 *   {{nameCamelPlural}}   camelCase-plural JS identifier ("accounts", "userTokens")
 *   {{nameCamelSingular}} camelCase-singular JS identifier ("account", "userToken")
 *   {{NamePlural}}        PascalCase-plural ("Accounts", "UserTokens")
 *   {{NameSingular}}      PascalCase-singular ("Account", "UserToken")
 *   {{NAME_PLURAL}}       SCREAMING_SNAKE-plural ("ACCOUNTS", "USER_TOKENS")
 *   {{NAME_SINGULAR}}     SCREAMING_SNAKE-singular ("ACCOUNT", "USER_TOKEN")
 *
 * The substitution applies to file *contents* and to *file names*: a
 * template file `services/Service.ts.tpl` becomes
 * `services/{{NameSingular}}Service.ts.tpl` in the generator's name-rule
 * (e.g., `services/AccountService.ts`). Template files end in `.tpl` so
 * they're not picked up by tsc / vitest scanning the cli/ tree.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.join(__dirname, "..", "templates", "module");

export async function generateCommand(type, name, opts = {}) {
  switch (type) {
    case "module":
      return generateModule(name, opts);
    case "resource":
      return generateResource(name, opts);
    case "middleware":
      return generateMiddleware(name, opts);
    case "service":
      return generateService(name, opts);
    case "schema":
      return generateSchema(name, opts);
    case "job":
      return generateJob(name, opts);
    default:
      throw new Error(
        `ship-api g ${type} is not yet implemented. ` +
          `Currently supported: module, resource, middleware, service, schema, job. ` +
          `(Other generators like \`test\` land in subsequent commits.)`,
      );
  }
}

/**
 * `g resource <name> --fields "title:string,body:text,published:boolean?"`.
 *
 * Like `g module` but customizes the schema + validation files to the
 * supplied field spec instead of the default `name:varchar(200)`. Field
 * format: `name:type[?]` — the `?` suffix marks the field nullable
 * (Drizzle column lacks `.notNull()`, Zod schema is `.optional()`).
 *
 * Supported types: string (varchar), text, integer, bigint, boolean,
 * timestamp, uuid, json. Any unknown type maps to `text` with a
 * `// TODO[ship-api]` marker on the column.
 */
export async function generateResource(rawName, opts = {}) {
  const fields = parseFieldSpec(opts.fields ?? "");
  if (fields.length === 0) {
    throw new Error(
      `g resource: --fields is required (e.g. --fields "title:string,body:text,published:boolean?")`,
    );
  }

  // Run the full module scaffold first (skeleton with the default `name`
  // field). Post-process to swap in the field spec.
  const moduleResult = await generateModule(rawName, {
    ...opts,
    silent: true,
    generator: "resource",
  });

  await rewriteSchemaForFields(path.join(moduleResult.targetRoot, "schema.ts"), fields);
  await rewriteValidationForFields(
    path.join(moduleResult.targetRoot, "validation", "schemas.ts"),
    fields,
  );

  if (!opts.silent) {
    printResourceReport(rawName, moduleResult, fields);
  }
  return { ...moduleResult, fields };
}

const FIELD_TYPE_MAP = {
  string: { drizzle: "varchar(NAME, { length: 255 })", zod: "z.string()" },
  text: { drizzle: "text(NAME)", zod: "z.string()" },
  integer: { drizzle: "integer(NAME)", zod: "z.number().int()" },
  number: { drizzle: "integer(NAME)", zod: "z.number().int()" },
  bigint: {
    drizzle: 'bigint(NAME, { mode: "number" })',
    zod: "z.number().int()",
  },
  boolean: { drizzle: "boolean(NAME)", zod: "z.boolean()" },
  timestamp: {
    drizzle: "timestamp(NAME, { withTimezone: true })",
    zod: "z.coerce.date()",
  },
  uuid: { drizzle: "uuid(NAME)", zod: "z.string().uuid()" },
  json: {
    drizzle: "jsonb(NAME).$type<Record<string, unknown>>()",
    zod: "z.record(z.string(), z.unknown())",
  },
};

export function parseFieldSpec(spec) {
  if (!spec) return [];
  const fields = [];
  for (const part of spec.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(`g resource: malformed field "${trimmed}" — expected "name:type[?]"`);
    }
    const name = trimmed.slice(0, colon).trim();
    let typeRaw = trimmed.slice(colon + 1).trim();
    let nullable = false;
    if (typeRaw.endsWith("?")) {
      nullable = true;
      typeRaw = typeRaw.slice(0, -1);
    }
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) {
      throw new Error(
        `g resource: invalid field name "${name}" — must be camelCase starting with a letter`,
      );
    }
    const known = Object.hasOwn(FIELD_TYPE_MAP, typeRaw);
    fields.push({
      name,
      type: typeRaw,
      nullable,
      known,
    });
  }
  return fields;
}

function renderSchemaColumns(fields) {
  const lines = [];
  for (const f of fields) {
    const colName = snakeize(f.name);
    const mapping = FIELD_TYPE_MAP[f.type];
    if (!mapping) {
      lines.push(
        `    ${f.name}: text("${colName}")${f.nullable ? "" : ".notNull()"}, // TODO[ship-api]: unknown type "${f.type}"`,
      );
      continue;
    }
    const drizzleExpr = mapping.drizzle.replace("NAME", `"${colName}"`);
    const notNull = f.nullable ? "" : ".notNull()";
    lines.push(`    ${f.name}: ${drizzleExpr}${notNull},`);
  }
  return lines.join("\n");
}

function renderImportsForFields(fields) {
  const imports = new Set();
  for (const f of fields) {
    if (!f.known) {
      imports.add("text");
      continue;
    }
    // Extract the function name from the drizzle expression.
    const match = FIELD_TYPE_MAP[f.type].drizzle.match(/^(\w+)\(/);
    if (match) imports.add(match[1]);
  }
  return imports;
}

function renderCreateSchemaFields(fields) {
  const lines = [];
  for (const f of fields) {
    const mapping = FIELD_TYPE_MAP[f.type];
    const zod = mapping ? mapping.zod : "z.unknown() /* TODO[ship-api]: unknown type */";
    const optional = f.nullable ? ".optional()" : "";
    lines.push(`    ${f.name}: ${zod}${optional},`);
  }
  return lines.join("\n");
}

function renderUpdateSchemaFields(fields) {
  // Update schemas: every field is optional (PATCH semantics).
  const lines = [];
  for (const f of fields) {
    const mapping = FIELD_TYPE_MAP[f.type];
    const zod = mapping ? mapping.zod : "z.unknown() /* TODO[ship-api]: unknown type */";
    const nullable = f.nullable ? ".nullable()" : "";
    lines.push(`    ${f.name}: ${zod}${nullable}.optional(),`);
  }
  return lines.join("\n");
}

function snakeize(camel) {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

async function rewriteSchemaForFields(schemaPath, fields) {
  const original = await fs.readFile(schemaPath, "utf8");
  // Replace the default `name: varchar(...)` line with the rendered
  // field columns. The template has exactly one `name:` line between
  // the `id:` line and `...baseFields`.
  const columnsBlock = renderSchemaColumns(fields);
  const replaced = original.replace(
    / {2}name: varchar\("name", \{ length: 200 \}\)\.notNull\(\),/,
    columnsBlock,
  );
  // Update the imports: the template imports varchar; now we import
  // whatever the field types need.
  const neededImports = renderImportsForFields(fields);
  neededImports.add("pgTable");
  neededImports.add("uuid"); // primary key
  const importList = [...neededImports].sort().join(", ");
  const withImports = replaced.replace(
    /import \{ pgTable, uuid, varchar \} from "drizzle-orm\/pg-core";/,
    `import { ${importList} } from "drizzle-orm/pg-core";`,
  );
  await fs.writeFile(schemaPath, withImports);
}

async function rewriteValidationForFields(validationPath, fields) {
  const original = await fs.readFile(validationPath, "utf8");
  const createBlock = renderCreateSchemaFields(fields);
  const updateBlock = renderUpdateSchemaFields(fields);

  // The template's create schema has a single `name: z.string()...`
  // line; replace it with the field block. Same for update.
  const createReplaced = original.replace(
    / {4}name: z\.string\(\)\.min\(1\)\.max\(200\),\n/,
    createBlock + "\n",
  );
  const updateReplaced = createReplaced.replace(
    / {4}name: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\),\n/,
    updateBlock + "\n",
  );

  await fs.writeFile(validationPath, updateReplaced);
}

function printResourceReport(rawName, moduleResult, fields) {
  console.log("");
  console.log(
    chalk.bold(`ship-api g resource ${rawName}`),
    chalk.dim(`→ ${moduleResult.targetRoot}`),
  );
  console.log("");
  for (const f of moduleResult.files) {
    console.log("  ", chalk.green("✚"), path.relative(moduleResult.targetRoot, f));
  }
  console.log("");
  console.log(chalk.dim("Fields:"));
  for (const f of fields) {
    const marker = f.nullable ? "?" : " ";
    const known = f.known ? "" : chalk.yellow("  [unknown type — review]");
    console.log(`  ${marker} ${chalk.cyan(f.name)}: ${f.type}${known}`);
  }
  console.log("");
  console.log(chalk.dim("Next steps:"));
  console.log(
    chalk.dim("  • Add the schema to your composed schema:"),
    chalk.cyan(
      `createApp({ schema: { ${moduleResult.names.namePlural}: ${moduleResult.names.namePlural} } })`,
    ),
  );
  console.log(
    chalk.dim("  • Mount the module sub-app on the root:"),
    chalk.cyan(
      `const routedApp = root.route("/", build${moduleResult.names.NamePlural}App({ service, provider }))`,
    ),
  );
  console.log(chalk.dim("  • Run:"), chalk.cyan("npm run db:generate"));
  console.log("");
  console.log(
    chalk.dim("Scaffold metadata recorded in module.json (start-point for delivery metrics)."),
  );
  console.log("");
}

export async function generateModule(rawName, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const targetRoot =
    opts.targetRoot ?? path.join(cwd, "src", "modules", normalizeNamePlural(rawName));

  const names = computeNames(rawName);
  await ensureTargetEmpty(targetRoot, opts.force ?? false);
  const written = await writeTemplate(TEMPLATE_ROOT, targetRoot, names);
  await stampScaffoldMetadata(targetRoot, names, opts);

  if (!opts.silent) {
    printReport(rawName, names, targetRoot, written);
  }
  return { targetRoot, names, files: written };
}

// ─── In-module file generators ────────────────────────────────────────
//
// `g middleware <name>` — adds a Hono middleware skeleton at
// `src/middleware/<name>.ts` in the consumer's project.
//
// `g service <name> -m <module>` — adds a `<NameSingular>Service.ts`
// to an existing module's `services/` directory.
//
// `g schema <name> -m <module>` — adds an extra Drizzle pgTable file
// to a module's tree at `modules/<module>/schemas/<name>.ts`.
//
// `g job <name> -m <module>` — adds a BullMQ job stub at
// `modules/<module>/jobs/<name>.job.ts`.
//
// All four use the same name-substitution machinery as `g module`.

export async function generateMiddleware(rawName, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const names = computeMiddlewareNames(rawName);
  const targetPath =
    opts.targetPath ?? path.join(cwd, "src", "middleware", `${names.nameKebab}.ts`);
  await ensureFileVacant(targetPath, opts.force ?? false);

  const contents = renderMiddleware(names);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents);

  if (!opts.silent) printSingleFileReport("middleware", rawName, targetPath);
  return { targetPath, names };
}

export async function generateService(rawName, opts = {}) {
  if (!opts.module) {
    throw new Error("g service: --module is required (which module to add the service to)");
  }
  const cwd = opts.cwd ?? process.cwd();
  const moduleNames = computeNames(opts.module);
  const moduleDir = path.join(cwd, "src", "modules", moduleNames.namePlural);
  await ensureModuleDirExists(moduleDir, opts.module);

  const names = computeServiceNames(rawName);
  const fileName = `${names.NameSingular}Service.ts`;
  const targetPath = opts.targetPath ?? path.join(moduleDir, "services", fileName);
  await ensureFileVacant(targetPath, opts.force ?? false);

  const contents = renderService(names, moduleNames);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents);

  if (!opts.silent) printSingleFileReport("service", rawName, targetPath);
  return { targetPath, names, moduleNames };
}

export async function generateSchema(rawName, opts = {}) {
  if (!opts.module) {
    throw new Error("g schema: --module is required");
  }
  const cwd = opts.cwd ?? process.cwd();
  const moduleNames = computeNames(opts.module);
  const moduleDir = path.join(cwd, "src", "modules", moduleNames.namePlural);
  await ensureModuleDirExists(moduleDir, opts.module);

  const names = computeSchemaNames(rawName);
  const targetPath = opts.targetPath ?? path.join(moduleDir, "schemas", `${names.nameKebab}.ts`);
  await ensureFileVacant(targetPath, opts.force ?? false);

  const contents = renderSchema(names);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents);

  if (!opts.silent) printSingleFileReport("schema", rawName, targetPath);
  return { targetPath, names, moduleNames };
}

export async function generateJob(rawName, opts = {}) {
  if (!opts.module) {
    throw new Error("g job: --module is required");
  }
  const cwd = opts.cwd ?? process.cwd();
  const moduleNames = computeNames(opts.module);
  const moduleDir = path.join(cwd, "src", "modules", moduleNames.namePlural);
  await ensureModuleDirExists(moduleDir, opts.module);

  const names = computeJobNames(rawName);
  const targetPath = opts.targetPath ?? path.join(moduleDir, "jobs", `${names.nameKebab}.job.ts`);
  await ensureFileVacant(targetPath, opts.force ?? false);

  const contents = renderJob(names, moduleNames);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, contents);

  if (!opts.silent) printSingleFileReport("job", rawName, targetPath);
  return { targetPath, names, moduleNames };
}

// ─── Name helpers (each subcommand has a slightly different shape) ────

function computeMiddlewareNames(raw) {
  const kebab = rawNameToKebab(raw, "g middleware");
  return {
    nameKebab: kebab,
    nameCamel: kebabToCamel(kebab),
    NamePascal: kebabToPascal(kebab),
  };
}

function computeServiceNames(raw) {
  const kebab = rawNameToKebab(raw, "g service");
  // Service names are typically singular ("Account", not "Accounts").
  const singular = singularizeKebab(kebab);
  return {
    nameKebab: singular,
    NameSingular: kebabToPascal(singular),
    nameCamelSingular: kebabToCamel(singular),
  };
}

function computeSchemaNames(raw) {
  const kebab = rawNameToKebab(raw, "g schema");
  // Pluralized for table name (matches the v4 convention — tables are plural).
  const plural = pluralizeKebab(singularizeKebab(kebab));
  return {
    nameKebab: kebab,
    namePlural: plural,
    nameSingular: singularizeKebab(plural),
    nameCamelPlural: kebabToCamel(plural),
    NamePascal: kebabToPascal(singularizeKebab(plural)),
  };
}

function computeJobNames(raw) {
  const kebab = rawNameToKebab(raw, "g job");
  return {
    nameKebab: kebab,
    nameCamel: kebabToCamel(kebab),
    NamePascal: kebabToPascal(kebab),
  };
}

function rawNameToKebab(raw, contextLabel) {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${contextLabel}: name cannot be empty`);
  const kebab = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  const cleaned = kebab.replace(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9-]*$/.test(cleaned)) {
    throw new Error(
      `${contextLabel}: invalid name "${raw}" — must be kebab-case starting with a letter`,
    );
  }
  return cleaned;
}

// ─── File renderers ────────────────────────────────────────────────────

function renderMiddleware(names) {
  return `import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "@sixthsummit/ship-api/http/app/createApp";

/**
 * \`${names.nameCamel}({ ... })\` — Hono middleware factory.
 *
 * Customize the options + the before/after-handler logic. Wire the
 * middleware into the route chain (or globally via \`app.use("*", ...)\`).
 */

export interface ${names.NamePascal}Options {
  // TODO: declare middleware-specific options here.
}

export function ${names.nameCamel}(
  opts: ${names.NamePascal}Options = {},
): MiddlewareHandler<AppEnv> {
  void opts;
  return async (c, next) => {
    // Before-handler logic (auth checks, request enrichment, etc.).

    await next();

    // After-handler logic (response shaping, headers, observability).
  };
}
`;
}

function renderService(names, moduleNames) {
  return `import { DrizzleEntityService } from "@sixthsummit/ship-api/app/services/DrizzleEntityService";
import { ${moduleNames.nameCamelPlural} } from "../schema.js";

/**
 * \`${names.NameSingular}Service\` — extends \`DrizzleEntityService\` against
 * the module's \`${moduleNames.nameCamelPlural}\` table. Inherits get / getAll /
 * list / count / create / update / delete with soft-delete + audit-column
 * auto-stamping; add domain-specific methods below.
 */
export class ${names.NameSingular}Service extends DrizzleEntityService<
  typeof ${moduleNames.nameCamelPlural},
  { ${moduleNames.nameCamelPlural}: typeof ${moduleNames.nameCamelPlural} }
> {
  protected getTable() {
    return ${moduleNames.nameCamelPlural};
  }

  protected override getDefaultSearchFields(): readonly string[] {
    return [];
  }

  // Domain-specific methods go here. Example:
  //
  //   async findByExternalId(externalId: string) { ... }
}
`;
}

function renderSchema(names) {
  return `import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";

/**
 * Replace this skeleton with the real columns + indexes for
 * \`${names.namePlural}\`. Run \`npm run db:generate\` after editing.
 */
export const ${names.nameCamelPlural} = pgTable("${names.namePlural}", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  ...baseFields,
});

export type ${names.NamePascal} = typeof ${names.nameCamelPlural}.$inferSelect;
export type New${names.NamePascal} = typeof ${names.nameCamelPlural}.$inferInsert;
`;
}

function renderJob(names, moduleNames) {
  return `import { z } from "zod";

/**
 * \`${names.nameKebab}\` — BullMQ job for the ${moduleNames.namePlural} module.
 *
 * Replace the payload schema + processor body with the real
 * implementation. The framework auto-discovers default exports
 * named \`${names.nameKebab}.job.ts\` when \`InitJobs\` runs at boot
 * (with \`WORKER_MODE=worker\` or \`all\`).
 *
 * NOTE: This is a stub that ships ahead of the framework's
 * \`defineJob\` API export. Once \`defineJob\` lands in the public
 * barrel, swap the placeholder export below for:
 *
 *   import { defineJob } from "@sixthsummit/ship-api";
 *   export default defineJob({ ... });
 */

export const ${names.nameCamel}PayloadSchema = z.object({
  // TODO: declare the payload shape.
});

export type ${names.NamePascal}Payload = z.infer<
  typeof ${names.nameCamel}PayloadSchema
>;

export const ${names.nameCamel}Job = {
  queue: "${moduleNames.namePlural}",
  name: "${names.nameKebab}",
  payloadSchema: ${names.nameCamel}PayloadSchema,
  async processor(payload: ${names.NamePascal}Payload): Promise<void> {
    void payload;
    // TODO: implement.
  },
};

export default ${names.nameCamel}Job;
`;
}

// ─── Shared filesystem helpers ─────────────────────────────────────────

async function ensureFileVacant(targetPath, force) {
  try {
    await fs.access(targetPath);
    if (!force) {
      throw new Error(`Target ${targetPath} already exists (pass --force to overwrite)`);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    if (err.message?.startsWith("Target")) throw err;
    throw err;
  }
}

async function ensureModuleDirExists(moduleDir, moduleName) {
  try {
    const stat = await fs.stat(moduleDir);
    if (!stat.isDirectory()) {
      throw new Error(`Module path ${moduleDir} is not a directory`);
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        `Module "${moduleName}" not found at ${moduleDir} — run \`ship-api g module ${moduleName}\` first`,
      );
    }
    throw err;
  }
}

function printSingleFileReport(kind, rawName, targetPath) {
  console.log("");
  console.log(chalk.bold(`ship-api g ${kind} ${rawName}`), chalk.dim(`→ ${targetPath}`));
  console.log("");
  console.log("  ", chalk.green("✚"), targetPath);
  console.log("");
}

function normalizeNamePlural(raw) {
  // Accept "accounts", "Account", "user-tokens", "userToken", etc.; emit
  // canonical kebab-case-plural. Idempotent — feeding "accounts" back in
  // returns "accounts" (not "accountses").
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("g module: name cannot be empty");
  // Convert camelCase / PascalCase boundaries to dashes, lowercase.
  const kebab = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
  const cleaned = kebab.replace(/^-+|-+$/g, "");
  if (!/^[a-z][a-z0-9-]*$/.test(cleaned)) {
    throw new Error(
      `g module: invalid name "${raw}" — must be kebab-case starting with a letter (a-z, 0-9, -).`,
    );
  }
  // Idempotent pluralization: re-pluralizing the singularized form
  // recovers the same plural regardless of what the user passed.
  return pluralizeKebab(singularizeKebab(cleaned));
}

export function computeNames(raw) {
  const namePlural = normalizeNamePlural(raw);
  const nameSingular = singularizeKebab(namePlural);
  return {
    namePlural,
    nameSingular,
    nameCamelPlural: kebabToCamel(namePlural),
    nameCamelSingular: kebabToCamel(nameSingular),
    NamePlural: kebabToPascal(namePlural),
    NameSingular: kebabToPascal(nameSingular),
    NAME_PLURAL: namePlural.replace(/-/g, "_").toUpperCase(),
    NAME_SINGULAR: nameSingular.replace(/-/g, "_").toUpperCase(),
  };
}

function kebabToPascal(kebab) {
  return kebab
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function kebabToCamel(kebab) {
  const parts = kebab.split("-").filter(Boolean);
  if (parts.length === 0) return "";
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
  );
}

/**
 * Pluralize the LAST segment of a kebab-case identifier — keeps multi-
 * word module names readable (`user-token` → `user-tokens`, not
 * `user-tokens` becoming the unholy `user-tokenses`).
 */
function pluralizeKebab(kebab) {
  const parts = kebab.split("-");
  parts[parts.length - 1] = pluralizeWord(parts[parts.length - 1]);
  return parts.join("-");
}

function singularizeKebab(kebab) {
  const parts = kebab.split("-");
  parts[parts.length - 1] = singularizeWord(parts[parts.length - 1]);
  return parts.join("-");
}

/**
 * Minimal English pluralization — handles the common cases that show up
 * in module names. Engineers naming a module `mongoose-octopi` get
 * what they deserve.
 */
function pluralizeWord(word) {
  if (word.endsWith("y") && !"aeiou".includes(word[word.length - 2]))
    return word.slice(0, -1) + "ies";
  if (
    word.endsWith("s") ||
    word.endsWith("x") ||
    word.endsWith("z") ||
    word.endsWith("ch") ||
    word.endsWith("sh")
  )
    return word + "es";
  if (word.endsWith("o") && !"aeiou".includes(word[word.length - 2])) return word + "es";
  return word + "s";
}

function singularizeWord(word) {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("sses") || word.endsWith("shes") || word.endsWith("ches"))
    return word.slice(0, -2);
  if (word.endsWith("xes") || word.endsWith("zes") || word.endsWith("oes"))
    return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// Backwards-compat exports for tests that already imported the per-segment
// helpers under the original names.
const pluralize = pluralizeWord;
const singularize = singularizeWord;

async function ensureTargetEmpty(target, force) {
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target);
      if (entries.length > 0 && !force) {
        throw new Error(`g module: target ${target} is not empty (pass --force to overwrite)`);
      }
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    if (err.message?.startsWith("g module:")) throw err;
    throw err;
  }
}

async function writeTemplate(templateRoot, targetRoot, names) {
  const files = [];
  await walk(templateRoot, templateRoot, async (srcPath, relPath) => {
    if (!srcPath.endsWith(".tpl")) return;
    const targetRel = applyNameSubstitutions(relPath.slice(0, -".tpl".length), names);
    const targetPath = path.join(targetRoot, targetRel);
    const contents = await fs.readFile(srcPath, "utf8");
    const substituted = applyNameSubstitutions(contents, names);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, substituted);
    files.push(targetPath);
  });
  return files;
}

/**
 * Recursive directory walker. The `root` argument is the original walk
 * root and stays constant through recursion so `relPath` is always the
 * subpath under the original root, not just the filename.
 */
async function walk(root, dir, visit) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, visit);
    } else if (entry.isFile()) {
      const rel = path.relative(root, full);
      await visit(full, rel);
    }
  }
}

function applyNameSubstitutions(text, names) {
  // Order matters: replace the longer, more-specific tokens first so
  // `{{NamePlural}}` doesn't get half-eaten by `{{Name`-prefix matches.
  return text
    .replaceAll("{{nameCamelPlural}}", names.nameCamelPlural)
    .replaceAll("{{nameCamelSingular}}", names.nameCamelSingular)
    .replaceAll("{{NamePlural}}", names.NamePlural)
    .replaceAll("{{NameSingular}}", names.NameSingular)
    .replaceAll("{{NAME_PLURAL}}", names.NAME_PLURAL)
    .replaceAll("{{NAME_SINGULAR}}", names.NAME_SINGULAR)
    .replaceAll("{{namePlural}}", names.namePlural)
    .replaceAll("{{nameSingular}}", names.nameSingular);
}

/**
 * Stamp un-backfillable scaffold provenance into the module's
 * `module.json`. This is the start-point breadcrumb for the
 * "time-to-module" delivery metric (see `docs/DELIVERY_METRICS.md`, M3):
 * it records *when* a module was generated, by *which* generator, and
 * under *which* framework version — independent of commit-message
 * discipline, because the field rides into git as part of the module and
 * cannot be reconstructed after the fact.
 *
 * The timestamp and framework version are injectable via `opts.now` and
 * `opts.frameworkVersion` so the generator stays deterministic under test.
 * If a (future) template ships no `module.json`, stamping is a no-op
 * rather than an error.
 */
async function stampScaffoldMetadata(targetRoot, names, opts) {
  const manifestPath = path.join(targetRoot, "module.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return;
  }
  manifest.scaffold = {
    generator: opts.generator ?? "module",
    name: names.namePlural,
    at: normalizeTimestamp(opts.now),
    frameworkVersion: opts.frameworkVersion ?? (await resolveFrameworkVersion()),
    tool: detectScaffoldTool(opts),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Best-effort detection of the agent/editor that drove this scaffold, for the
 * by-tool split of the time-to-module metric (DELIVERY_METRICS M3/M6 — agent
 * output-parity). Precedence: explicit `opts.tool` (test injection) >
 * `SHIP_API_SCAFFOLD_TOOL` (the reliable override) > env markers > "cli".
 *
 * Marker caveats — why the override is the canonical path:
 *  - Claude Code exports `CLAUDECODE=1` (its documented presence flag). We key
 *    on exactly that, not the broader `CLAUDE_CODE_*` family, because env is
 *    inherited by child processes — a Cursor/CLI run launched from a shell that
 *    once hosted Claude Code could otherwise be mislabelled. (The single flag
 *    narrows, though doesn't eliminate, that inheritance surface.)
 *  - Cursor has no canonical equivalent of `CLAUDECODE`; `CURSOR_TRACE_ID` is a
 *    best-effort signal and is often absent, so a Cursor run usually falls
 *    through to "cli". Cursor users should set `SHIP_API_SCAFFOLD_TOOL=cursor`
 *    so the by-tool metric attributes correctly.
 *
 * "cli" is a valid, honest answer, not a failure. `env` is injectable for
 * tests. (Reading process.env here is fine — build tooling, not framework
 * runtime, so it doesn't route through `defineEnv`.)
 */
export function detectScaffoldTool(opts = {}, env = process.env) {
  if (opts.tool) return opts.tool;
  if (env.SHIP_API_SCAFFOLD_TOOL) return env.SHIP_API_SCAFFOLD_TOOL;
  if (env.CLAUDECODE) return "claude-code";
  if (env.CURSOR_TRACE_ID) return "cursor";
  return "cli";
}

function normalizeTimestamp(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now.length > 0) return now;
  return new Date().toISOString();
}

let _frameworkVersionCache;

/**
 * The version of `@sixthsummit/ship-api` running this generator, read from
 * the package root (two levels up from `cli/commands/`) — used as the
 * default `frameworkVersion` in scaffold provenance. Falls back to
 * `"unknown"` if the package.json can't be read. Memoized.
 */
async function resolveFrameworkVersion() {
  if (_frameworkVersionCache !== undefined) return _frameworkVersionCache;
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    _frameworkVersionCache = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    _frameworkVersionCache = "unknown";
  }
  return _frameworkVersionCache;
}

function printReport(rawName, names, targetRoot, written) {
  console.log("");
  console.log(chalk.bold(`ship-api g module ${rawName}`), chalk.dim(`→ ${targetRoot}`));
  console.log("");
  for (const f of written) {
    console.log("  ", chalk.green("✚"), path.relative(targetRoot, f));
  }
  console.log("");
  console.log(chalk.dim("Next steps:"));
  console.log(
    chalk.dim("  • Add the schema to your composed schema:"),
    chalk.cyan(`createApp({ schema: { ${names.namePlural}: ${names.namePlural} } })`),
  );
  console.log(
    chalk.dim(
      "  • Mount the module sub-app on the root (capture the return — it carries the RPC types):",
    ),
    chalk.cyan(
      `const routedApp = root.route("/", build${names.NamePlural}App({ service, provider }))`,
    ),
  );
  console.log(
    chalk.dim("    and point the typed-client export at it:"),
    chalk.cyan(`export type ShipApiClient = typeof routedApp`),
  );
  console.log(chalk.dim("  • Run:"), chalk.cyan("npm run db:generate"));
  console.log("");
  console.log(
    chalk.dim("Scaffold metadata recorded in module.json (start-point for delivery metrics)."),
  );
  console.log("");
}

// Exposed for tests.
export const __test = {
  computeNames,
  applyNameSubstitutions,
  pluralize,
  singularize,
  kebabToPascal,
  kebabToCamel,
  computeMiddlewareNames,
  computeServiceNames,
  computeSchemaNames,
  computeJobNames,
  parseFieldSpec,
  renderSchemaColumns,
  renderCreateSchemaFields,
  renderUpdateSchemaFields,
  TEMPLATE_ROOT,
};
