import chalk from "chalk";
import fs from "fs/promises";
import path from "path";
import ts from "typescript";

/**
 * `ship-api migrate-orm <path>` — codemod CLI for v3 → v4 ORM
 * migration. Best-effort translation from TypeORM `AbstractEntity`
 * subclasses to Drizzle `pgTable` schemas.
 *
 * This first slice ships **`--analyze` mode** (default): walks the
 * given path (single file or directory tree), parses each `.ts` file
 * with the TypeScript compiler API, and classifies every TypeORM
 * decorator it finds as one of:
 *
 *   - "auto"    — codemod will translate cleanly
 *   - "partial" — codemod handles the common case but the user must
 *                 review (e.g., complex column types, custom transformers)
 *   - "manual"  — the codemod can't translate; the user rewrites
 *                 (lifecycle hooks, computed properties, table inheritance)
 *
 * Output is a per-file report with counts and an aggregate summary.
 * Emits a `// TODO[ship-api migrate-orm]:` line per "manual" finding
 * the consumer can grep for.
 *
 * The actual `--write` transformation lands in a follow-up commit.
 * Shipping `--analyze` first lets v3 holdouts scope the migration
 * before committing to the codemod.
 *
 * Implementation: regex-light, AST-heavy. Walks the TS AST
 * (`ts.forEachChild`) and inspects every `Decorator` node's
 * `expression` for the canonical TypeORM names. Classification table
 * is the source of truth — adding a new decorator means one entry
 * here, not three.
 */

const SUPPORT_TABLE = {
  // Class-level
  Entity: { kind: "auto", note: "→ pgTable(name, {...})" },
  Index: { kind: "partial", note: "review composite-key cases" },
  Unique: { kind: "auto", note: "→ unique() chain on column" },
  TableInheritance: { kind: "manual", note: "no Drizzle equivalent — flatten" },
  // Property-level: simple columns
  Column: { kind: "partial", note: "primitives auto; custom types manual" },
  PrimaryColumn: { kind: "auto", note: "→ pgColumn().primaryKey()" },
  PrimaryGeneratedColumn: {
    kind: "auto",
    note: '→ uuid("id").primaryKey().defaultRandom()',
  },
  ObjectIdColumn: { kind: "manual", note: "MongoDB-only; no Drizzle equivalent" },
  // Property-level: audit columns (codemod emits baseFields shorthand)
  CreateDateColumn: {
    kind: "auto",
    note: "→ baseFields.createdAt (note rename from createdDate)",
  },
  UpdateDateColumn: {
    kind: "auto",
    note: "→ baseFields.updatedAt (note rename from updatedDate)",
  },
  DeleteDateColumn: {
    kind: "auto",
    note: "→ baseFields.deletedAt (note rename from deletedDate)",
  },
  VersionColumn: { kind: "manual", note: "no Drizzle equivalent — drop or hand-roll" },
  // Property-level: relations
  OneToOne: { kind: "partial", note: "review @JoinColumn ownership" },
  OneToMany: { kind: "partial", note: "→ relations() block; review eager-load" },
  ManyToOne: { kind: "partial", note: "→ foreign-key column + relations()" },
  ManyToMany: {
    kind: "partial",
    note: "→ join-table; review @JoinTable + custom names",
  },
  JoinColumn: { kind: "auto", note: "merged into ManyToOne fk" },
  JoinTable: { kind: "auto", note: "merged into ManyToMany join-table" },
  // Lifecycle (manual rewrite to LifecycleHooks)
  BeforeInsert: { kind: "manual", note: "→ DrizzleEntityService.beforeCreate" },
  AfterInsert: { kind: "manual", note: "→ DrizzleEntityService.afterCreate" },
  BeforeUpdate: { kind: "manual", note: "→ DrizzleEntityService.beforeUpdate" },
  AfterUpdate: { kind: "manual", note: "→ DrizzleEntityService.afterUpdate" },
  BeforeRemove: { kind: "manual", note: "→ DrizzleEntityService.beforeDelete" },
  AfterRemove: { kind: "manual", note: "→ DrizzleEntityService.afterDelete" },
  AfterLoad: { kind: "manual", note: "no Drizzle equivalent — move to service" },
  // Other
  Generated: { kind: "manual", note: "review uuid/identity behavior" },
  Tree: { kind: "manual", note: "tree-pattern; no direct Drizzle helper" },
  ViewEntity: { kind: "manual", note: "→ pgView definition" },
};

/**
 * v3 ShipAPI-specific decorators the codemod doesn't auto-rewrite (they
 * live on controllers / methods, not entities), but knows the migration
 * shape for. Surface as `kind: "hint"` findings — actionable v3→v4
 * translation guidance instead of a generic "manual review".
 *
 * Each entry is `(slug, node) => string` returning the message body.
 */
const HINT_DECORATORS = {
  HasPermission: (slug) =>
    slug
      ? `in routes.ts: add \`requirePermission(${JSON.stringify(slug)})\` middleware to the route registering this controller method`
      : "v3 controller-method auth — migrate to `requirePermission(<slug>)` middleware on the matching route in routes.ts",
  HasContextPermission: (slug) =>
    slug
      ? `in routes.ts: add \`requireContextPermission(${JSON.stringify(slug)})\` middleware to the route registering this controller method`
      : "v3 context-aware auth — migrate to `requireContextPermission(<slug>)` middleware on the matching route in routes.ts",
};

const TS_EXTENSIONS = new Set([".ts", ".tsx"]);

export async function migrateOrmCommand(opts = {}) {
  const target = opts.path ?? ".";
  const writeMode = opts.write === true;

  if (writeMode) {
    return runWriteMode(target, opts);
  }

  const entries = await collectFiles(target);
  if (entries.length === 0) {
    console.log(chalk.yellow(`No .ts files found at ${target} — nothing to analyze.`));
    return { files: [], summary: { auto: 0, partial: 0, manual: 0 } };
  }

  const fileReports = [];
  for (const file of entries) {
    fileReports.push(await analyzeFile(file));
  }

  printAnalysisReport(fileReports, target);

  const summary = aggregate(fileReports);
  return { files: fileReports, summary };
}

async function collectFiles(target) {
  const stat = await fs.stat(target).catch(() => null);
  if (!stat) return [];
  if (stat.isFile()) {
    return TS_EXTENSIONS.has(path.extname(target)) ? [target] : [];
  }
  const out = [];
  await walkDir(target, out);
  return out;
}

async function walkDir(dir, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(full, out);
    } else if (TS_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

export async function analyzeFile(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const findings = [];
  const visit = (node) => {
    const decorators = ts.canHaveDecorators?.(node) ? ts.getDecorators?.(node) : undefined;
    if (decorators) {
      for (const d of decorators) {
        const name = decoratorName(d);
        if (!name) continue;
        const support = SUPPORT_TABLE[name];
        const line = sourceFile.getLineAndCharacterOfPosition(d.getStart(sourceFile)).line + 1;
        if (support) {
          findings.push({
            decorator: name,
            kind: support.kind,
            note: support.note,
            line,
            target: nodeKindLabel(node),
          });
        } else if (HINT_DECORATORS[name]) {
          // v3 ShipAPI-specific decorators the codemod doesn't auto-fix
          // but knows the migration shape for. Surface an actionable
          // hint with the slug + target method baked in, instead of a
          // generic "manual review".
          const slug = extractFirstStringArg(d);
          findings.push({
            decorator: name,
            kind: "hint",
            note: HINT_DECORATORS[name](slug, node),
            line,
            target: nodeKindLabel(node),
          });
        } else {
          findings.push({
            decorator: name,
            kind: "unknown",
            note: "decorator not in support table — manual review",
            line,
            target: nodeKindLabel(node),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    file: filePath,
    findings,
    counts: countByKind(findings),
  };
}

function decoratorName(decorator) {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression)) return expr.expression.text;
    if (ts.isPropertyAccessExpression(expr.expression)) return expr.expression.name.text;
  } else if (ts.isIdentifier(expr)) {
    return expr.text;
  } else if (ts.isPropertyAccessExpression(expr)) {
    return expr.name.text;
  }
  return undefined;
}

function nodeKindLabel(node) {
  if (ts.isClassDeclaration(node)) return `class ${node.name?.text ?? "?"}`;
  if (ts.isPropertyDeclaration(node)) return `property ${node.name.getText()}`;
  if (ts.isMethodDeclaration(node)) return `method ${node.name.getText()}`;
  if (ts.isParameter(node)) return `parameter ${node.name.getText?.() ?? "?"}`;
  return ts.SyntaxKind[node.kind];
}

function countByKind(findings) {
  const counts = { auto: 0, partial: 0, manual: 0, unknown: 0, hint: 0 };
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

function aggregate(fileReports) {
  const summary = { auto: 0, partial: 0, manual: 0, unknown: 0, hint: 0 };
  for (const r of fileReports) {
    for (const k of Object.keys(summary)) {
      summary[k] += r.counts[k] ?? 0;
    }
  }
  return summary;
}

function printAnalysisReport(fileReports, target) {
  const symbol = (kind) =>
    kind === "auto"
      ? chalk.green("✔ auto   ")
      : kind === "partial"
        ? chalk.cyan("~ partial")
        : kind === "manual"
          ? chalk.yellow("! manual ")
          : kind === "hint"
            ? chalk.magenta("→ hint   ")
            : chalk.red("? unknown");

  console.log("");
  console.log(chalk.bold(`ship-api migrate-orm — analyze ${target}`));
  console.log("");

  const filesWithFindings = fileReports.filter((r) => r.findings.length > 0);
  if (filesWithFindings.length === 0) {
    console.log(chalk.dim("  (no TypeORM decorators detected)"));
    console.log("");
    return;
  }

  for (const report of filesWithFindings) {
    console.log(chalk.dim(report.file));
    for (const f of report.findings) {
      const loc = chalk.dim(`L${f.line}`);
      const decorator = chalk.bold(`@${f.decorator}`);
      console.log(`  ${symbol(f.kind)}  ${loc}  ${decorator} on ${f.target} — ${f.note}`);
    }
    console.log("");
  }

  const summary = aggregate(fileReports);
  console.log(
    chalk.dim(
      `  summary: ${summary.auto} auto · ${summary.partial} partial · ${summary.hint} hint · ${summary.manual} manual · ${summary.unknown} unknown`,
    ),
  );
  console.log("");
  console.log(
    chalk.dim(
      "  Run with `--write` to emit Drizzle pgTable schemas next to each entity (Account.ts → Account.drizzle.ts).",
    ),
  );
  console.log("");
}

// ───────────────────── Write mode ─────────────────────

const COLUMN_DECORATORS = new Set([
  "Column",
  "PrimaryColumn",
  "PrimaryGeneratedColumn",
  "CreateDateColumn",
  "UpdateDateColumn",
  "DeleteDateColumn",
]);
const RELATION_DECORATORS = new Set(["OneToOne", "OneToMany", "ManyToOne", "ManyToMany"]);
const AUDIT_DECORATORS = new Set(["CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn"]);

/**
 * Compute the `*.drizzle.ts` output path for an entity source file.
 *
 * Rule: strip a trailing `.entity` segment (if present) before appending
 * `.drizzle.ts`, so `token.entity.ts` → `token.drizzle.ts` (not the
 * awkward stacked `token.entity.drizzle.ts`). Files that don't follow
 * the `*.entity.ts` convention keep their stem unchanged:
 * `Account.ts` → `Account.drizzle.ts`.
 */
export function entityToOutputPath(file) {
  return file.replace(/(?:\.entity)?\.ts$/, ".drizzle.ts");
}

async function runWriteMode(target, opts) {
  const entries = await collectFiles(target);
  if (entries.length === 0) {
    console.log(chalk.yellow(`No .ts files found at ${target} — nothing to transform.`));
    return { files: [] };
  }

  const written = [];
  const skipped = [];
  for (const file of entries) {
    const result = await transformFile(file);
    if (!result.ok) {
      skipped.push({ file, reason: result.reason });
      continue;
    }
    const outPath = entityToOutputPath(file);
    await fs.writeFile(outPath, result.content);
    written.push(outPath);
  }

  if (!opts.silent) {
    printWriteReport(target, written, skipped);
  }
  return { files: written, skipped };
}

/**
 * Transform a single TypeORM entity file's source text into a Drizzle
 * `pgTable` schema file's source text. Returns `{ ok: true, content }`
 * on success, `{ ok: false, reason }` when the file has no @Entity
 * class to translate (skipped silently in directory walks).
 */
export async function transformText(source, opts = {}) {
  const fileName = opts.fileName ?? "entity.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const entityClass = findEntityClass(sourceFile);
  if (!entityClass) {
    return { ok: false, reason: "no @Entity class found" };
  }

  const description = await describeEntity(entityClass, sourceFile, fileName);
  const content = renderDrizzleSchema(description);
  return { ok: true, content };
}

export async function transformFile(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  return transformText(source, { fileName: filePath });
}

function findEntityClass(sourceFile) {
  let entityClass;
  function visit(node) {
    if (entityClass) return;
    if (ts.isClassDeclaration(node)) {
      const decorators = ts.getDecorators?.(node) ?? [];
      const hasEntity = decorators.some((d) => decoratorName(d) === "Entity");
      if (hasEntity) {
        entityClass = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return entityClass;
}

async function describeEntity(classNode, sourceFile, sourceFilePath) {
  const className = classNode.name?.text ?? "Entity";
  const classDecorators = ts.getDecorators?.(classNode) ?? [];

  const entityDecorator = classDecorators.find((d) => decoratorName(d) === "Entity");
  const explicitTableName = entityDecorator ? extractFirstStringArg(entityDecorator) : undefined;
  const tableName = explicitTableName ?? defaultTableName(className);

  // Class-level @Index — emitted as a positional `(table) => [...]`
  // arg on pgTable, so collect them now.
  const classIndexes = classDecorators
    .filter((d) => decoratorName(d) === "Index")
    .map((d) => extractIndexInfo(d));

  // Walk the heritage chain (extends Y extends Z ...) and pull decorated
  // properties from base classes. Without this, `class Proposal extends
  // TenantScopedEntity { ... }` silently drops every field on the parent
  // (id, tenantId, audit columns) and emits an unusable Drizzle table.
  const inheritance = await walkInheritanceChain(classNode, sourceFile, sourceFilePath);

  // Collect this class's own decorated properties.
  const ownProperties = collectDecoratedProperties(classNode, sourceFile);

  // Prepend inherited (parent fields appear first in the table; child
  // fields can shadow if same propertyName — but valid TypeORM doesn't
  // re-declare an inherited @Column, so this almost never happens).
  const properties = [...inheritance.properties, ...ownProperties];

  // Class-level @Index from base classes are merged in too.
  const allClassIndexes = [...inheritance.classIndexes, ...classIndexes];

  return {
    className,
    tableName,
    classIndexes: allClassIndexes,
    properties,
    inheritedFrom: inheritance.inheritedFrom,
    inheritanceTodos: inheritance.todos,
    sourceFilePath,
  };
}

/**
 * Pull decorated property descriptors from a class declaration (any
 * class — used both for the @Entity class itself and for ancestors
 * during the heritage walk).
 */
function collectDecoratedProperties(classNode, sourceFile) {
  const properties = [];
  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    const decorators = ts.getDecorators?.(member) ?? [];
    if (decorators.length === 0) continue;
    const desc = describeProperty(member, decorators, sourceFile);
    if (desc) properties.push(desc);
  }
  return properties;
}

/**
 * Recursively walk `extends X extends Y` and merge in each ancestor's
 * decorated properties. Stops at:
 *   - Framework-only base classes (e.g. `@sixthsummit/ship-api/app/entity/AbstractEntity`)
 *     — silent skip (no TODO; documented v3-only artifact, expected).
 *   - Already-visited class names — circular inheritance, surfaced as TODO.
 *   - Unresolvable imports — surfaced as TODO so the user can chase the
 *     missing parent manually.
 */
async function walkInheritanceChain(classNode, sourceFile, sourceFilePath, visited = new Set()) {
  const result = {
    properties: [],
    classIndexes: [],
    inheritedFrom: [],
    todos: [],
  };

  const extendedName = getExtendedClassName(classNode);
  if (!extendedName) return result;
  if (visited.has(extendedName)) {
    result.todos.push(`circular inheritance detected at \`${extendedName}\` — skipped recursion`);
    return result;
  }
  visited.add(extendedName);

  const resolved = await resolveExtendedClassImport(extendedName, sourceFile, sourceFilePath);

  if (resolved.kind === "framework-only") {
    // v3 AbstractEntity (etc.) is a documented no-translate boundary.
    // Don't TODO; the user already knows.
    return result;
  }
  if (resolved.kind === "unresolvable") {
    result.todos.push(
      `parent class \`${extendedName}\` could not be resolved (${resolved.reason}) — inherited fields not merged`,
    );
    return result;
  }

  // Locate the parent class declaration.
  let parentClass;
  let parentSourceFile;
  let parentFilePath;
  if (resolved.kind === "same-file") {
    parentClass = findClassByName(sourceFile, extendedName);
    parentSourceFile = sourceFile;
    parentFilePath = sourceFilePath;
  } else {
    // External file — read + parse.
    let raw;
    try {
      raw = await fs.readFile(resolved.absPath, "utf8");
    } catch (err) {
      result.todos.push(
        `parent class \`${extendedName}\` file at ${resolved.absPath} could not be read (${err.code ?? err.message}) — inherited fields not merged`,
      );
      return result;
    }
    parentSourceFile = ts.createSourceFile(
      resolved.absPath,
      raw,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );
    parentClass = findClassByName(parentSourceFile, extendedName);
    parentFilePath = resolved.absPath;
  }

  if (!parentClass) {
    result.todos.push(
      `parent class \`${extendedName}\` not found in resolved file — inherited fields not merged`,
    );
    return result;
  }

  // Single Table Inheritance (parent itself is @Entity-decorated): rare,
  // not auto-translated. Surface as TODO; do not merge fields (each entity
  // gets its own table in v4).
  const parentDecorators = ts.getDecorators?.(parentClass) ?? [];
  const parentIsEntity = parentDecorators.some((d) => decoratorName(d) === "Entity");
  if (parentIsEntity) {
    result.todos.push(
      `parent class \`${extendedName}\` is itself \`@Entity\`-decorated (Single Table Inheritance) — not auto-translated; each entity needs its own pgTable`,
    );
    return result;
  }

  // Recurse first (grandparent fields go before parent fields).
  const grandparent = await walkInheritanceChain(
    parentClass,
    parentSourceFile,
    parentFilePath,
    visited,
  );
  result.properties.push(...grandparent.properties);
  result.classIndexes.push(...grandparent.classIndexes);
  result.inheritedFrom.push(...grandparent.inheritedFrom);
  result.todos.push(...grandparent.todos);

  // Then this parent's own fields.
  const parentProperties = collectDecoratedProperties(parentClass, parentSourceFile);
  result.properties.push(...parentProperties);

  // Parent's class-level @Index decorators.
  const parentClassIndexes = parentDecorators
    .filter((d) => decoratorName(d) === "Index")
    .map((d) => extractIndexInfo(d));
  result.classIndexes.push(...parentClassIndexes);

  result.inheritedFrom.push({
    className: extendedName,
    sourcePath: parentFilePath,
    fieldCount: parentProperties.length,
  });

  return result;
}

/** Walk the AST for a class declaration with a matching name. */
function findClassByName(sourceFile, className) {
  let target;
  function visit(node) {
    if (target) return;
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      target = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return target;
}

/** Read the `extends X` (or `extends Foo.X`) class name. */
function getExtendedClassName(classNode) {
  const heritageClauses = classNode.heritageClauses ?? [];
  for (const clause of heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const firstType = clause.types?.[0];
    if (!firstType) continue;
    const expr = firstType.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  }
  return null;
}

const FRAMEWORK_PACKAGE_PREFIXES = ["@sixthsummit/ship-api", "typeorm"];

/**
 * Look up the extended class's source location.
 *
 * Returns one of:
 *   { kind: "same-file" }
 *   { kind: "external-file", absPath }
 *   { kind: "framework-only", path }      — silent skip
 *   { kind: "unresolvable", reason }      — TODO emission
 */
async function resolveExtendedClassImport(extendedName, sourceFile, sourceFilePath) {
  // Same-file check first — many projects define the abstract base
  // alongside the entity (or use a single shared entities/ file).
  if (findClassByName(sourceFile, extendedName)) {
    return { kind: "same-file" };
  }

  // Walk imports. Match by local name (default import or named import).
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpecifier = stmt.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const specText = moduleSpecifier.text;

    let matches = false;
    const importClause = stmt.importClause;
    if (importClause?.name?.text === extendedName) matches = true;
    if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const elem of importClause.namedBindings.elements) {
        if (elem.name.text === extendedName) {
          matches = true;
          break;
        }
      }
    }
    if (!matches) continue;

    // Framework / external package. Don't try to recurse; framework
    // base classes (AbstractEntity) are documented v3-only.
    if (
      FRAMEWORK_PACKAGE_PREFIXES.some((p) => specText === p || specText.startsWith(p + "/")) ||
      (!specText.startsWith(".") && !specText.startsWith("/"))
    ) {
      return { kind: "framework-only", path: specText };
    }

    // Relative path — try to resolve to an absolute file path.
    const resolved = await resolveRelativeImport(specText, sourceFilePath);
    if (!resolved) {
      return {
        kind: "unresolvable",
        reason: `could not resolve "${specText}" relative to ${sourceFilePath}`,
      };
    }
    return { kind: "external-file", absPath: resolved };
  }

  return {
    kind: "unresolvable",
    reason: `no import for \`${extendedName}\` found`,
  };
}

/**
 * Resolve a relative import specifier to an absolute file path, trying
 * common TS extensions + index.ts fallback.
 */
async function resolveRelativeImport(spec, fromFile) {
  const stripped = spec.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, "");
  const baseDir = path.dirname(fromFile);
  const candidates = [
    path.resolve(baseDir, stripped + ".ts"),
    path.resolve(baseDir, stripped + ".tsx"),
    path.resolve(baseDir, stripped, "index.ts"),
    path.resolve(baseDir, stripped, "index.tsx"),
  ];
  for (const c of candidates) {
    try {
      await fs.stat(c);
      return c;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function describeProperty(propertyNode, decorators, sourceFile) {
  const propertyName = propertyNode.name.getText(sourceFile);
  const decoratorList = decorators.map((d) => ({
    name: decoratorName(d),
    args: d.expression && ts.isCallExpression(d.expression) ? d.expression.arguments : [],
    raw: d,
  }));

  const isAudit = decoratorList.some((d) => AUDIT_DECORATORS.has(d.name));
  const columnDecorator = decoratorList.find((d) => COLUMN_DECORATORS.has(d.name));
  const relationDecorator = decoratorList.find((d) => RELATION_DECORATORS.has(d.name));

  if (isAudit) {
    // Detect the v3 audit-column trio. Each property contributes the
    // audit-column kind so the renderer can emit `...baseFields` once
    // instead of three separate columns.
    return {
      kind: "audit",
      propertyName,
      auditKind: decoratorList.find((d) => AUDIT_DECORATORS.has(d.name)).name,
    };
  }

  if (relationDecorator) {
    return {
      kind: "relation-todo",
      propertyName,
      decorator: relationDecorator.name,
    };
  }

  if (!columnDecorator) {
    return null;
  }

  return describeColumn(propertyName, columnDecorator, decoratorList);
}

function describeColumn(propertyName, columnDecorator, allDecorators) {
  if (columnDecorator.name === "PrimaryGeneratedColumn") {
    const generationKind = extractFirstStringArg(columnDecorator.raw);
    return {
      kind: "primary",
      propertyName,
      generationKind: generationKind ?? "uuid",
    };
  }

  if (columnDecorator.name === "PrimaryColumn") {
    const sqlType = extractFirstStringArg(columnDecorator.raw);
    return {
      kind: "primary-explicit",
      propertyName,
      sqlType: sqlType ?? "text",
      options: extractObjectArg(columnDecorator.raw, 1),
    };
  }

  // Column or one of its variants the codemod doesn't yet handle.
  const sqlType = extractFirstStringArg(columnDecorator.raw);
  const options = extractObjectArg(columnDecorator.raw, sqlType ? 1 : 0);
  return {
    kind: "column",
    propertyName,
    sqlType: sqlType ?? "text",
    options,
    hasUnique: allDecorators.some((d) => d.name === "Unique"),
  };
}

function extractFirstStringArg(decorator) {
  if (!decorator.expression || !ts.isCallExpression(decorator.expression)) return undefined;
  const first = decorator.expression.arguments[0];
  if (!first) return undefined;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return undefined;
}

function extractObjectArg(decorator, index) {
  if (!decorator.expression || !ts.isCallExpression(decorator.expression)) return {};
  const arg = decorator.expression.arguments[index];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return {};
  const out = {};
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText();
    out[key] = readLiteral(prop.initializer);
  }
  return out;
}

function extractIndexInfo(decorator) {
  if (!decorator.expression || !ts.isCallExpression(decorator.expression))
    return { name: undefined, columns: [], options: {} };
  const args = decorator.expression.arguments;
  let name;
  let columns = [];
  let options = {};
  for (const a of args) {
    if (ts.isStringLiteral(a)) {
      name = a.text;
    } else if (ts.isArrayLiteralExpression(a)) {
      columns = a.elements.filter((e) => ts.isStringLiteral(e)).map((e) => e.text);
    } else if (ts.isObjectLiteralExpression(a)) {
      options = readObjectLiteral(a);
    }
  }
  return { name, columns, options };
}

function readLiteral(node) {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isObjectLiteralExpression(node)) return readObjectLiteral(node);
  if (ts.isArrayLiteralExpression(node)) {
    // Array literals — common as `default: []` on jsonb columns. Try to
    // parse as JSON so we can serialize back out for the `sql\`'...'::jsonb\``
    // template; fall back to __raw if the array contains non-literal
    // expressions (identifiers, function calls, etc.).
    const text = node.getText();
    try {
      return JSON.parse(text);
    } catch {
      return { __raw: text };
    }
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // `default: () => "now()"` etc. — preserve the source text so the
    // emitter can re-render verbatim. Drizzle defaults use either a
    // sql`` template or a literal value.
    return { __raw: node.getText() };
  }
  return undefined;
}

function readObjectLiteral(node) {
  const out = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    out[prop.name.getText()] = readLiteral(prop.initializer);
  }
  return out;
}

// ───────────────────── Rendering ─────────────────────

function renderDrizzleSchema(desc) {
  const auditProperties = desc.properties.filter((p) => p.kind === "audit");
  const useBaseFields = auditProperties.length >= 2; // any 2+ of the trio → use baseFields
  const todos = collectRenderTodos(desc);
  const columnLines = [];
  const importsNeeded = new Set(["pgTable"]);
  // Imports outside `drizzle-orm/pg-core` (e.g. the `sql` template for
  // jsonb defaults, which lives in `drizzle-orm`). renderColumnLine adds
  // to this set when needed.
  const ctx = { extraImports: new Set() };

  for (const prop of desc.properties) {
    if (prop.kind === "audit") continue; // handled by ...baseFields
    if (prop.kind === "relation-todo") continue; // surfaced in todos block
    const line = renderColumnLine(prop, importsNeeded, ctx);
    if (line) columnLines.push(line);
  }

  if (useBaseFields) {
    columnLines.push("    ...baseFields,");
  }

  // Render @Index entries on the table.
  const indexLines = desc.classIndexes.map((idx) => renderIndex(idx)).filter(Boolean);
  if (indexLines.length > 0) importsNeeded.add("index");

  const importParts = [...importsNeeded].sort().join(", ");
  const baseFieldsImport = useBaseFields
    ? `import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";\n`
    : "";
  const drizzleOrmImport = ctx.extraImports.has("sql")
    ? `import { sql } from "drizzle-orm";\n`
    : "";

  const body =
    `export const ${camelize(desc.tableName)} = pgTable(\n` +
    `  "${desc.tableName}",\n` +
    `  {\n${columnLines.join("\n")}\n  }` +
    (indexLines.length > 0
      ? `,\n  (table) => [\n${indexLines.map((l) => "    " + l).join(",\n")},\n  ]`
      : "") +
    `,\n);\n\n`;

  const types =
    `export type ${desc.className} = typeof ${camelize(desc.tableName)}.$inferSelect;\n` +
    `export type New${desc.className} = typeof ${camelize(desc.tableName)}.$inferInsert;\n`;

  const todosBlock =
    todos.length > 0
      ? `\n/*\n * TODO[ship-api migrate-orm]: review the following items\n * — they need manual translation:\n${todos.map((t) => ` *   • ${t}`).join("\n")}\n */\n\n`
      : "\n";

  // Inherits-from header — informational, NOT a TODO. Tells the user
  // which fields came from the heritage chain so they don't get
  // surprised by an `id` / `tenantId` they didn't declare on the entity.
  const inheritsHeader =
    desc.inheritedFrom && desc.inheritedFrom.length > 0
      ? desc.inheritedFrom
          .map(
            (i) =>
              `// Inherits ${i.className} (${i.fieldCount} field${i.fieldCount === 1 ? "" : "s"} merged from ${path.relative(path.dirname(desc.sourceFilePath ?? ""), i.sourcePath) || i.sourcePath}).\n`,
          )
          .join("")
      : "";

  return (
    `// Generated by \`ship-api migrate-orm --write\`.\n` +
    `// Original entity: ${desc.className}.\n` +
    inheritsHeader +
    `// Review the TODO[ship-api migrate-orm] markers below before relying on this file.\n\n` +
    `import { ${importParts} } from "drizzle-orm/pg-core";\n` +
    drizzleOrmImport +
    baseFieldsImport +
    todosBlock +
    body +
    types
  );
}

function renderColumnLine(prop, importsNeeded, ctx = { extraImports: new Set() }) {
  if (prop.kind === "primary") {
    importsNeeded.add("uuid");
    return `    id: uuid("id").primaryKey().defaultRandom(),`;
  }
  if (prop.kind === "primary-explicit") {
    const drizzleType = mapTypeOrmTypeToDrizzle(prop.sqlType);
    importsNeeded.add(drizzleType.fn);
    const colName = snakeize(prop.propertyName);
    return `    ${prop.propertyName}: ${drizzleType.fn}("${colName}"${drizzleType.argSuffix}).primaryKey(),`;
  }
  if (prop.kind !== "column") return null;

  const drizzleType = mapTypeOrmTypeToDrizzle(prop.sqlType);
  importsNeeded.add(drizzleType.fn);
  const colName = snakeize(prop.propertyName);
  const opts = prop.options ?? {};

  // Compute the argSuffix dynamically. The static map uses sane defaults
  // for each SQL type (e.g. varchar gets `{ length: 255 }`); decimal /
  // numeric override that with the entity's precision/scale when present.
  let argSuffix = drizzleType.argSuffix;
  if (
    (prop.sqlType === "decimal" || prop.sqlType === "numeric") &&
    (opts.precision !== undefined || opts.scale !== undefined)
  ) {
    const parts = [];
    if (opts.precision !== undefined) parts.push(`precision: ${opts.precision}`);
    if (opts.scale !== undefined) parts.push(`scale: ${opts.scale}`);
    argSuffix = `, { ${parts.join(", ")} }`;
  }

  let chain = `${drizzleType.fn}("${colName}"${argSuffix})`;

  // .notNull() — TypeORM defaults to NOT NULL unless `nullable: true`.
  // Drizzle defaults to NULLABLE. Match TypeORM's default.
  if (opts.nullable !== true) chain += ".notNull()";

  // .default(...) — best-effort. Strings/numbers/booleans pass through;
  // jsonb/json arrays + objects get re-serialized via `sql\`'...'::<type>\``.
  if (opts.default !== undefined) {
    const defaultExpr = renderDefaultExpression(opts.default, prop.sqlType, ctx);
    if (defaultExpr !== null) {
      chain += `.default(${defaultExpr})`;
    }
  }

  // .unique() — column-level
  if (opts.unique === true || prop.hasUnique) chain += ".unique()";

  return `    ${prop.propertyName}: ${chain},`;
}

/**
 * Render a Drizzle `.default(...)` expression for a v3 `@Column({ default: X })`
 * value. Returns the expression string (e.g. `"draft"`, `0`,
 * `sql\`'[]'::jsonb\``), or null if the value can't be expressed and
 * should be skipped (renderer drops the .default call).
 *
 * For arrays + plain objects on jsonb/json columns, emits a `sql` tag
 * — sets `ctx.extraImports.add("sql")` so the renderer pulls in
 * `import { sql } from "drizzle-orm";` at the top of the file.
 */
function renderDefaultExpression(value, sqlType, ctx) {
  // Array or non-empty object literal — jsonb / json expects a
  // `sql\`'<json>'::<type>\`` template. Other column types fall through
  // to the legacy primitive renderer (with TODO if it can't represent).
  const isComplexLiteral =
    Array.isArray(value) || (value !== null && typeof value === "object" && !("__raw" in value));

  if (isComplexLiteral && (sqlType === "jsonb" || sqlType === "json")) {
    ctx.extraImports.add("sql");
    const json = JSON.stringify(value);
    return `sql\`'${json}'::${sqlType}\``;
  }

  // Arrow-function default expressions — `() => "<sql>"` — TypeORM's
  // documented "raw SQL default" idiom. Used heavily for jsonb defaults
  // and SQL functions like `() => "now()"`. Emits as `sql\`<inner>\``
  // so Drizzle treats the body as a SQL fragment, preserving v3's
  // exact column-level semantics.
  if (value && typeof value === "object" && "__raw" in value) {
    const innerSql = parseArrowFunctionRawSql(value.__raw);
    if (innerSql !== null) {
      ctx.extraImports.add("sql");
      return `sql\`${innerSql}\``;
    }
  }

  // Primitives (string / number / boolean / null) and unrecognized
  // __raw shapes fall through to the legacy renderer (which emits a
  // TODO marker for the latter).
  return renderDefaultValue(value);
}

/**
 * Parse the raw text of a v3 TypeORM arrow-function default —
 * `() => "<sql>"` — and return the inner SQL expression. Returns
 * null if the shape isn't a recognized arrow-fn-returning-string-literal.
 *
 * Examples (input → return):
 *   () => "'{}'"           → '{}'
 *   () => "'{}'::jsonb"    → '{}'::jsonb
 *   () => "now()"          → now()
 *   () => `now()`          → now()       (template-literal body)
 *   (x) => "..."           → null        (parameterized — invalid for default)
 *   () => 42               → null        (non-string body — fall through)
 */
function parseArrowFunctionRawSql(rawText) {
  if (typeof rawText !== "string") return null;
  const trimmed = rawText.trim();
  // Match: () [: type]? => <quoted-string-body>
  // The quote can be ", ', or `. Captures the inner body verbatim.
  const match = /^\(\s*\)(?:\s*:\s*[^=]+?)?\s*=>\s*(["'`])([\s\S]*)\1\s*$/.exec(trimmed);
  if (!match) return null;
  return match[2];
}

function renderDefaultValue(v) {
  if (v && typeof v === "object" && "__raw" in v) {
    // Function expression like `() => "now()"` — preserve via sql tag.
    return "/* TODO[ship-api migrate-orm]: review default */ undefined";
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "/* TODO */ undefined";
}

function renderIndex(idx) {
  const cols = idx.columns.map((c) => `table.${c}`).join(", ");
  const name = idx.name ? JSON.stringify(idx.name) : '""';
  return `index(${name}).on(${cols})`;
}

function collectRenderTodos(desc) {
  const todos = [];
  for (const prop of desc.properties) {
    if (prop.kind === "relation-todo") {
      todos.push(
        `relation property \`${prop.propertyName}\` (@${prop.decorator}) — restore via Drizzle relations() block + a foreign-key column`,
      );
    }
    if (prop.kind === "column" && prop.options?.transformer) {
      todos.push(
        `column \`${prop.propertyName}\` had a custom \`transformer\` — re-implement at the service layer`,
      );
    }
  }
  // Inheritance-walk TODOs (circular / unresolvable / Single Table
  // Inheritance — anything the walk couldn't auto-translate).
  if (desc.inheritanceTodos && desc.inheritanceTodos.length > 0) {
    todos.push(...desc.inheritanceTodos);
  }
  return todos;
}

const TYPEORM_TO_DRIZZLE = {
  varchar: { fn: "varchar", argSuffix: ", { length: 255 }" },
  text: { fn: "text", argSuffix: "" },
  uuid: { fn: "uuid", argSuffix: "" },
  bigint: { fn: "bigint", argSuffix: ', { mode: "number" }' },
  int: { fn: "integer", argSuffix: "" },
  integer: { fn: "integer", argSuffix: "" },
  smallint: { fn: "smallint", argSuffix: "" },
  boolean: { fn: "boolean", argSuffix: "" },
  bool: { fn: "boolean", argSuffix: "" },
  timestamp: { fn: "timestamp", argSuffix: "" },
  timestamptz: {
    fn: "timestamp",
    argSuffix: ", { withTimezone: true }",
  },
  date: { fn: "date", argSuffix: "" },
  jsonb: { fn: "jsonb", argSuffix: "" },
  json: { fn: "json", argSuffix: "" },
  numeric: { fn: "numeric", argSuffix: "" },
  decimal: { fn: "decimal", argSuffix: "" },
  real: { fn: "real", argSuffix: "" },
  double: { fn: "doublePrecision", argSuffix: "" },
};

function mapTypeOrmTypeToDrizzle(t) {
  return TYPEORM_TO_DRIZZLE[t] ?? { fn: "text", argSuffix: "" };
}

function defaultTableName(className) {
  // TypeORM 0.3 default strategy: snake_case_pluralized class name.
  const snake = className.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  // Naive pluralization: if ends in s/x/z/ch/sh add es; consonant+y → ies; else add s.
  if (/(s|x|z|ch|sh)$/.test(snake)) return snake + "es";
  if (/[^aeiou]y$/.test(snake)) return snake.slice(0, -1) + "ies";
  return snake + "s";
}

function snakeize(camel) {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function camelize(snake) {
  return snake
    .split(/[_-]/)
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

function printWriteReport(target, written, skipped) {
  console.log("");
  console.log(chalk.bold(`ship-api migrate-orm --write ${target}`));
  console.log("");
  if (written.length > 0) {
    for (const file of written) {
      console.log("  ", chalk.green("✚"), file);
    }
  }
  if (skipped.length > 0) {
    console.log("");
    for (const { file, reason } of skipped) {
      console.log("  ", chalk.yellow("⤳"), file, chalk.dim(`(${reason})`));
    }
  }
  console.log("");
  console.log(chalk.dim("  Review the TODO[ship-api migrate-orm] markers in each generated file."));
  console.log("");
}

// Exposed for testing.
export const __test = {
  analyzeFile,
  decoratorName,
  countByKind,
  aggregate,
  SUPPORT_TABLE,
  transformText,
  describeEntity,
  defaultTableName,
  snakeize,
  camelize,
  mapTypeOrmTypeToDrizzle,
  entityToOutputPath,
};
