import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test } from "./migrate-orm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  analyzeFile,
  SUPPORT_TABLE,
  countByKind,
  aggregate,
  transformText,
  defaultTableName,
  snakeize,
  camelize,
  mapTypeOrmTypeToDrizzle,
  entityToOutputPath,
} = __test;

describe("ship-api migrate-orm — analyze mode", () => {
  let tmp;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "ship-api-migrate-orm-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeTs(name, body) {
    const file = path.join(tmp, name);
    await writeFile(file, body);
    return file;
  }

  describe("decorator detection + classification", () => {
    it("classifies @Entity as auto", async () => {
      const file = await writeTs(
        "user.ts",
        `
import { Entity } from "typeorm";
@Entity("users")
export class User {}
`,
      );
      const report = await analyzeFile(file);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({
        decorator: "Entity",
        kind: "auto",
        target: "class User",
      });
    });

    it("classifies @PrimaryGeneratedColumn + @Column on properties", async () => {
      const file = await writeTs(
        "user.ts",
        `
import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
@Entity()
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ length: 64 })
  name!: string;
}
`,
      );
      const report = await analyzeFile(file);
      const decorators = report.findings.map((f) => f.decorator);
      expect(decorators).toEqual(["Entity", "PrimaryGeneratedColumn", "Column"]);
      expect(report.findings[1].kind).toBe("auto");
      expect(report.findings[1].target).toBe("property id");
      expect(report.findings[2].kind).toBe("partial");
    });

    it("classifies audit columns (CreateDateColumn / UpdateDateColumn / DeleteDateColumn) as auto with rename note", async () => {
      const file = await writeTs(
        "audit.ts",
        `
import { Entity, CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from "typeorm";
@Entity()
export class T {
  @CreateDateColumn()
  createdDate!: Date;
  @UpdateDateColumn()
  updatedDate!: Date;
  @DeleteDateColumn()
  deletedDate!: Date;
}
`,
      );
      const report = await analyzeFile(file);
      const auditFindings = report.findings.filter((f) =>
        ["CreateDateColumn", "UpdateDateColumn", "DeleteDateColumn"].includes(f.decorator),
      );
      expect(auditFindings).toHaveLength(3);
      for (const f of auditFindings) {
        expect(f.kind).toBe("auto");
        expect(f.note).toMatch(/baseFields/);
        expect(f.note).toMatch(/rename/);
      }
    });

    it("classifies relations (ManyToOne / OneToMany / ManyToMany) as partial", async () => {
      const file = await writeTs(
        "rel.ts",
        `
import { Entity, ManyToOne, OneToMany, ManyToMany, JoinTable, JoinColumn } from "typeorm";
@Entity()
export class Post {
  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user!: any;

  @OneToMany(() => Comment, (c: any) => c.post)
  comments!: any[];

  @ManyToMany(() => Tag)
  @JoinTable()
  tags!: any[];
}
`,
      );
      const report = await analyzeFile(file);
      const partials = report.findings.filter((f) => f.kind === "partial");
      const partialNames = partials.map((f) => f.decorator);
      expect(partialNames).toContain("ManyToOne");
      expect(partialNames).toContain("OneToMany");
      expect(partialNames).toContain("ManyToMany");
      // JoinColumn / JoinTable themselves are auto (merged into the relation)
      const joins = report.findings.filter((f) =>
        ["JoinColumn", "JoinTable"].includes(f.decorator),
      );
      for (const j of joins) expect(j.kind).toBe("auto");
    });

    it("classifies lifecycle hooks (BeforeInsert / AfterUpdate / BeforeRemove etc.) as manual", async () => {
      const file = await writeTs(
        "hooks.ts",
        `
import { Entity, BeforeInsert, AfterUpdate, BeforeRemove, AfterLoad } from "typeorm";
@Entity()
export class T {
  @BeforeInsert()
  beforeInsert() {}
  @AfterUpdate()
  afterUpdate() {}
  @BeforeRemove()
  beforeRemove() {}
  @AfterLoad()
  afterLoad() {}
}
`,
      );
      const report = await analyzeFile(file);
      const manual = report.findings.filter((f) => f.kind === "manual");
      const names = manual.map((f) => f.decorator);
      expect(names).toEqual(
        expect.arrayContaining(["BeforeInsert", "AfterUpdate", "BeforeRemove", "AfterLoad"]),
      );
      // Notes should point at DrizzleEntityService hooks where applicable.
      const beforeInsert = report.findings.find((f) => f.decorator === "BeforeInsert");
      expect(beforeInsert.note).toMatch(/beforeCreate/);
    });

    it("classifies @Tree / @ViewEntity / @ObjectIdColumn as manual", async () => {
      const file = await writeTs(
        "advanced.ts",
        `
import { Entity, Tree, ViewEntity, ObjectIdColumn } from "typeorm";
@Tree("closure-table")
@Entity()
export class Cat {
  @ObjectIdColumn()
  _id!: any;
}
@ViewEntity({ expression: "select 1 as x" })
export class V {}
`,
      );
      const report = await analyzeFile(file);
      const manual = report.findings.filter((f) => f.kind === "manual");
      const names = manual.map((f) => f.decorator);
      expect(names).toContain("Tree");
      expect(names).toContain("ObjectIdColumn");
      expect(names).toContain("ViewEntity");
    });

    it("emits an actionable hint for @HasPermission with the slug + middleware shape (F2.5)", async () => {
      const file = await writeTs(
        "controller.ts",
        `
import { Entity } from "typeorm";
function HasPermission(slug: string): MethodDecorator { return () => {}; }
@Entity()
export class WidgetController {
  @HasPermission("widgets:read")
  async get() {}

  @HasPermission("widgets:create")
  async create() {}
}
`,
      );
      const report = await analyzeFile(file);
      const hints = report.findings.filter((f) => f.decorator === "HasPermission");
      // Both HasPermission decorators surface as kind: "hint", not
      // "unknown". The note carries the actionable middleware shape
      // with the slug pre-filled.
      expect(hints).toHaveLength(2);
      for (const h of hints) {
        expect(h.kind).toBe("hint");
        expect(h.note).toMatch(/requirePermission\(/);
        expect(h.note).toContain("routes.ts");
      }
      expect(hints[0].note).toContain('"widgets:read"');
      expect(hints[1].note).toContain('"widgets:create"');
    });

    it("emits a generic-but-still-actionable hint for @HasPermission with no slug arg", async () => {
      const file = await writeTs(
        "no-slug.ts",
        `
import { Entity } from "typeorm";
function HasPermission(): MethodDecorator { return () => {}; }
@Entity()
export class WidgetController {
  @HasPermission()
  async health() {}
}
`,
      );
      const report = await analyzeFile(file);
      const hint = report.findings.find((f) => f.decorator === "HasPermission");
      expect(hint?.kind).toBe("hint");
      expect(hint?.note).toMatch(/requirePermission/);
    });

    it("hint findings count toward the kind: 'hint' tally (not 'unknown')", async () => {
      const file = await writeTs(
        "tally.ts",
        `
import { Entity } from "typeorm";
function HasPermission(slug: string): MethodDecorator { return () => {}; }
@Entity()
export class Ctl {
  @HasPermission("a:b")
  async x() {}
}
`,
      );
      const report = await analyzeFile(file);
      expect(report.counts.hint).toBe(1);
      // No silent regression: HasPermission was previously "unknown".
      expect(report.counts.unknown).toBe(0);
    });

    it("flags unrecognized decorators as 'unknown' for manual review", async () => {
      const file = await writeTs(
        "custom.ts",
        `
import { Entity } from "typeorm";
function CustomDecorator(): any { return () => {}; }
@CustomDecorator()
@Entity()
export class Weird {}
`,
      );
      const report = await analyzeFile(file);
      const unknown = report.findings.find((f) => f.decorator === "CustomDecorator");
      expect(unknown).toBeDefined();
      expect(unknown.kind).toBe("unknown");
    });

    it("returns line numbers for each finding (1-indexed)", async () => {
      const file = await writeTs(
        "located.ts",
        `// L1
import { Entity, Column } from "typeorm"; // L2
// L3
@Entity()                                  // L4
export class T {
  @Column()
  name!: string;
}
`,
      );
      const report = await analyzeFile(file);
      const entityF = report.findings.find((f) => f.decorator === "Entity");
      expect(entityF.line).toBe(4);
    });

    it("returns empty findings for files with no decorators", async () => {
      const file = await writeTs(
        "plain.ts",
        `export const x = 1;
export function y() { return 2; }
`,
      );
      const report = await analyzeFile(file);
      expect(report.findings).toHaveLength(0);
    });
  });

  describe("aggregation helpers", () => {
    it("countByKind tallies findings per kind", () => {
      const findings = [
        { kind: "auto" },
        { kind: "auto" },
        { kind: "partial" },
        { kind: "manual" },
        { kind: "manual" },
        { kind: "manual" },
      ];
      expect(countByKind(findings)).toEqual({
        auto: 2,
        partial: 1,
        manual: 3,
        unknown: 0,
        hint: 0,
      });
    });

    it("aggregate sums counts across files", () => {
      const reports = [
        { counts: { auto: 1, partial: 0, manual: 2, unknown: 0, hint: 0 } },
        { counts: { auto: 3, partial: 1, manual: 0, unknown: 1, hint: 2 } },
      ];
      expect(aggregate(reports)).toEqual({
        auto: 4,
        partial: 1,
        manual: 2,
        unknown: 1,
        hint: 2,
      });
    });
  });

  describe("support table coverage", () => {
    it("table includes every TypeORM decorator the codebase actually uses today", () => {
      // Sanity check — keep this synced with the real surface.
      const must = [
        "Entity",
        "Column",
        "PrimaryGeneratedColumn",
        "PrimaryColumn",
        "CreateDateColumn",
        "UpdateDateColumn",
        "DeleteDateColumn",
        "ManyToOne",
        "OneToMany",
        "ManyToMany",
        "JoinColumn",
        "JoinTable",
        "Index",
        "Unique",
        "BeforeInsert",
        "AfterUpdate",
        "BeforeRemove",
      ];
      for (const name of must) {
        expect(SUPPORT_TABLE[name]).toBeDefined();
      }
    });
  });
});

describe("ship-api migrate-orm --write — transform mode", () => {
  describe("name helpers", () => {
    it("snakeize: camelCase → snake_case", () => {
      expect(snakeize("firstName")).toBe("first_name");
      expect(snakeize("isActive")).toBe("is_active");
      expect(snakeize("XYZ")).toBe("xyz");
      expect(snakeize("firebaseId")).toBe("firebase_id");
    });

    it("camelize: snake → camel", () => {
      expect(camelize("first_name")).toBe("firstName");
      expect(camelize("user_tokens")).toBe("userTokens");
      expect(camelize("accounts")).toBe("accounts");
    });

    it("defaultTableName: ClassName → snake_pluralized", () => {
      expect(defaultTableName("Account")).toBe("accounts");
      expect(defaultTableName("UserToken")).toBe("user_tokens");
      expect(defaultTableName("Watch")).toBe("watches");
      expect(defaultTableName("Box")).toBe("boxes");
      expect(defaultTableName("Story")).toBe("stories");
    });

    it("mapTypeOrmTypeToDrizzle: covers the common SQL types", () => {
      expect(mapTypeOrmTypeToDrizzle("varchar").fn).toBe("varchar");
      expect(mapTypeOrmTypeToDrizzle("varchar").argSuffix).toMatch(/length/);
      expect(mapTypeOrmTypeToDrizzle("text").fn).toBe("text");
      expect(mapTypeOrmTypeToDrizzle("uuid").fn).toBe("uuid");
      expect(mapTypeOrmTypeToDrizzle("boolean").fn).toBe("boolean");
      expect(mapTypeOrmTypeToDrizzle("int").fn).toBe("integer");
      expect(mapTypeOrmTypeToDrizzle("bigint").fn).toBe("bigint");
      expect(mapTypeOrmTypeToDrizzle("timestamp").fn).toBe("timestamp");
      expect(mapTypeOrmTypeToDrizzle("timestamptz").argSuffix).toMatch(/withTimezone: true/);
      expect(mapTypeOrmTypeToDrizzle("jsonb").fn).toBe("jsonb");
      // Unknown type falls back to `text`.
      expect(mapTypeOrmTypeToDrizzle("xxx").fn).toBe("text");
    });
  });

  describe("transformText", () => {
    it("returns ok=false when no @Entity class is found", async () => {
      const result = await transformText(`export const x = 1; export class NotAnEntity {}`);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no @Entity/i);
    });

    it("translates a simple @Entity with @Column primitives", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity("widgets")
        export class Widget {
          @PrimaryGeneratedColumn("uuid")
          id!: string;

          @Column("varchar")
          name!: string;

          @Column("integer", { default: 0 })
          count!: number;
        }
      `;
      const result = await transformText(source);
      expect(result.ok).toBe(true);
      expect(result.content).toContain('pgTable(\n  "widgets"');
      expect(result.content).toContain('id: uuid("id").primaryKey().defaultRandom()');
      expect(result.content).toContain('name: varchar("name", { length: 255 }).notNull()');
      expect(result.content).toContain('count: integer("count").notNull().default(0)');
    });

    it("respects @Entity() with no name argument (snake-pluralized class name)", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity()
        export class UserToken {
          @PrimaryGeneratedColumn("uuid")
          id!: string;
          @Column("varchar")
          token!: string;
        }
      `;
      const result = await transformText(source);
      expect(result.content).toContain('pgTable(\n  "user_tokens"');
      expect(result.content).toContain("export const userTokens = pgTable");
    });

    it("converts property names to snake_case for the SQL column name", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity()
        export class Account {
          @PrimaryGeneratedColumn("uuid")
          id!: string;

          @Column("varchar")
          firstName!: string;

          @Column("boolean", { default: true })
          isActive!: boolean;
        }
      `;
      const result = await transformText(source);
      expect(result.content).toContain('firstName: varchar("first_name", { length: 255 })');
      expect(result.content).toContain('isActive: boolean("is_active").notNull().default(true)');
    });

    it("emits ...baseFields when the audit-column trio is present (audit-rename absorbed)", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from "typeorm";
        @Entity()
        export class Audited {
          @PrimaryGeneratedColumn("uuid") id!: string;
          @Column("varchar") name!: string;
          @CreateDateColumn() createdDate!: Date;
          @UpdateDateColumn() updatedDate!: Date;
          @DeleteDateColumn() deletedDate!: Date;
        }
      `;
      const result = await transformText(source);
      expect(result.content).toContain("...baseFields,");
      expect(result.content).toContain(
        'import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields";',
      );
      // Audit columns should NOT be emitted as separate columns.
      expect(result.content).not.toMatch(/createdDate:|created_date:/);
      expect(result.content).not.toMatch(/deletedDate:|deleted_date:/);
    });

    it("includes Drizzle imports for every column type used (varchar, boolean, integer)", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity()
        export class Mixed {
          @PrimaryGeneratedColumn("uuid") id!: string;
          @Column("varchar") s!: string;
          @Column("integer") n!: number;
          @Column("boolean") b!: boolean;
        }
      `;
      const result = await transformText(source);
      const importLine = result.content.match(/import \{ ([^}]+) \} from "drizzle-orm\/pg-core";/);
      expect(importLine).toBeTruthy();
      const imports = importLine[1].split(",").map((s) => s.trim());
      expect(imports).toContain("varchar");
      expect(imports).toContain("integer");
      expect(imports).toContain("boolean");
      expect(imports).toContain("uuid");
      expect(imports).toContain("pgTable");
    });

    it("respects nullable: true (skips .notNull())", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity()
        export class T {
          @PrimaryGeneratedColumn("uuid") id!: string;
          @Column("varchar", { nullable: true }) note!: string;
        }
      `;
      const result = await transformText(source);
      expect(result.content).toMatch(/note: varchar\("note", \{ length: 255 \}\),/);
      expect(result.content).not.toMatch(/note:.*notNull/);
    });

    it("respects unique: true on @Column", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity()
        export class T {
          @PrimaryGeneratedColumn("uuid") id!: string;
          @Column("varchar", { unique: true }) email!: string;
        }
      `;
      const result = await transformText(source);
      expect(result.content).toContain(".unique()");
    });

    it("emits a TODO comment for @ManyToOne / @OneToMany / @ManyToMany relations", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany } from "typeorm";
        @Entity()
        export class Post {
          @PrimaryGeneratedColumn("uuid") id!: string;
          @ManyToOne(() => User, "user", { nullable: false })
          user!: any;
          @OneToMany(() => Comment, c => c.post)
          comments!: any[];
        }
      `;
      const result = await transformText(source);
      expect(result.content).toContain("TODO[ship-api migrate-orm]");
      expect(result.content).toContain("user");
      expect(result.content).toContain("@ManyToOne");
      expect(result.content).toContain("comments");
      expect(result.content).toContain("@OneToMany");
      // Relations are NOT emitted as columns.
      expect(result.content).not.toMatch(/^\s+user: /m);
    });

    it("emits valid type aliases", async () => {
      const source = `
        import { Entity, Column, PrimaryGeneratedColumn } from "typeorm";
        @Entity()
        export class Widget {
          @PrimaryGeneratedColumn("uuid") id!: string;
          @Column("varchar") name!: string;
        }
      `;
      const result = await transformText(source);
      expect(result.content).toContain("export type Widget = typeof widgets.$inferSelect");
      expect(result.content).toContain("export type NewWidget = typeof widgets.$inferInsert");
    });

    it("end-to-end against the real Account.ts entity (snapshot-style)", async () => {
      const source = `
        import {
          Column,
          Entity,
          ManyToOne,
          JoinColumn,
          PrimaryGeneratedColumn,
          CreateDateColumn,
          UpdateDateColumn,
          DeleteDateColumn,
        } from "typeorm";
        import { AbstractEntity } from "@sixthsummit/ship-api/app/entity/index";

        @Entity()
        export default class Account extends AbstractEntity {
          @PrimaryGeneratedColumn("uuid")
          id!: string;
          @Column("varchar", { unique: true })
          firebaseId!: string;
          @Column("varchar")
          firstName!: string;
          @Column("varchar")
          lastName!: string;
          @Column("varchar", { nullable: true })
          image?: string;
          @Column("varchar", { unique: true })
          email!: string;
          @Column("varchar", { nullable: true })
          phone!: string;
          @Column("boolean", { default: true })
          isActive!: boolean;
          @CreateDateColumn() createdDate!: Date;
          @UpdateDateColumn() updatedDate!: Date;
          @DeleteDateColumn({ select: false }) deletedDate!: Date;
          @ManyToOne("Role", "role", { nullable: false })
          @JoinColumn()
          role!: any;
        }
      `;
      const result = await transformText(source);
      expect(result.ok).toBe(true);
      // Spot-check the load-bearing pieces.
      expect(result.content).toContain('pgTable(\n  "accounts"');
      expect(result.content).toContain('id: uuid("id").primaryKey().defaultRandom()');
      expect(result.content).toContain(
        'firebaseId: varchar("firebase_id", { length: 255 }).notNull().unique()',
      );
      expect(result.content).toContain('image: varchar("image", { length: 255 }),');
      expect(result.content).toContain(
        'email: varchar("email", { length: 255 }).notNull().unique()',
      );
      expect(result.content).toContain('isActive: boolean("is_active").notNull().default(true)');
      expect(result.content).toContain("...baseFields,");
      expect(result.content).toContain("export type Account = typeof accounts");
      // The @ManyToOne `role` relation must surface as a TODO, not a column.
      expect(result.content).toContain("TODO[ship-api migrate-orm]");
      expect(result.content).toContain("role");
    });
  });

  describe("entityToOutputPath (F2.7)", () => {
    it("strips a trailing .entity segment before .drizzle.ts", () => {
      expect(entityToOutputPath("/abs/path/token.entity.ts")).toBe("/abs/path/token.drizzle.ts");
    });

    it("leaves non-.entity stems alone", () => {
      expect(entityToOutputPath("/abs/path/Account.ts")).toBe("/abs/path/Account.drizzle.ts");
      expect(entityToOutputPath("modules/connectors/entity/Connection.ts")).toBe(
        "modules/connectors/entity/Connection.drizzle.ts",
      );
    });

    it("only strips .entity at the end, not in the middle", () => {
      // A directory called "entity" or a file like "entity.helper.ts"
      // should NOT trigger the strip.
      expect(entityToOutputPath("/abs/entity/widget.ts")).toBe("/abs/entity/widget.drizzle.ts");
      expect(entityToOutputPath("/abs/path/entity.helper.ts")).toBe(
        "/abs/path/entity.helper.drizzle.ts",
      );
    });

    it("handles relative paths", () => {
      expect(entityToOutputPath("./src/token.entity.ts")).toBe("./src/token.drizzle.ts");
    });
  });

  describe("transformText — column-options preservation", () => {
    it("preserves decimal precision + scale (F2.2)", async () => {
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("invoice")
        export class Invoice {
          @Column("decimal", { precision: 10, scale: 2, default: 0 })
          subtotal!: number;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/invoice.ts" });
      expect(result.ok).toBe(true);
      // The precision/scale options must propagate through to the
      // decimal() column factory — without this, finance apps silently
      // change column type to default-precision numeric.
      expect(result.content).toContain(
        'subtotal: decimal("subtotal", { precision: 10, scale: 2 })',
      );
      // Default value still flows through.
      expect(result.content).toContain(".default(0)");
    });

    it("preserves precision-only or scale-only", async () => {
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("metric")
        export class Metric {
          @Column("numeric", { precision: 18 })
          big!: number;

          @Column("decimal", { scale: 4 })
          small!: number;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/metric.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain('numeric("big", { precision: 18 })');
      expect(result.content).toContain('decimal("small", { scale: 4 })');
    });

    it("decimal without precision/scale uses the default argSuffix", async () => {
      // Regression check — legacy entities that don't specify precision
      // shouldn't gain a `{}` argSuffix.
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("rate")
        export class Rate {
          @Column("decimal")
          value!: number;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/rate.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain('value: decimal("value").notNull()');
      expect(result.content).not.toContain("precision:");
    });

    it("jsonb default: [] emits sql template (F2.3)", async () => {
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("doc")
        export class Doc {
          @Column("jsonb", { default: [] })
          tags!: string[];
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/doc.ts" });
      expect(result.ok).toBe(true);
      // The sql tag preserves the v3 default semantics — DEFAULT '[]'::jsonb
      // — instead of dropping the default entirely (the pre-fix bug).
      expect(result.content).toContain(".default(sql`'[]'::jsonb`)");
      // The sql import lands separately from the pg-core imports.
      expect(result.content).toContain('import { sql } from "drizzle-orm"');
    });

    it("jsonb default: {} emits sql template", async () => {
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("config")
        export class Config {
          @Column("jsonb", { default: {} })
          settings!: Record<string, unknown>;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/config.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain(".default(sql`'{}'::jsonb`)");
    });

    it("json (not jsonb) with array default also gets sql template", async () => {
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("event")
        export class Event {
          @Column("json", { default: [] })
          payload!: unknown[];
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/event.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain(".default(sql`'[]'::json`)");
    });

    it("jsonb default with arrow-function form `() => \"'{}'\"` emits sql template (F8.2)", async () => {
      // The TypeORM "raw SQL default" idiom — used in real-world v3
      // apps for jsonb columns where the user wants the SQL-level
      // default committed exactly. Was previously emitted as
      // `.default(/* TODO */ undefined)` (broken — Drizzle reads that
      // as "no default"). Now emits sql`'{}'`.
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("settings")
        export class Settings {
          @Column("jsonb", { default: () => "'{}'" })
          outroCard!: Record<string, unknown>;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/settings.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain(".default(sql`'{}'`)");
      expect(result.content).toContain('import { sql } from "drizzle-orm"');
      // Critical regression check: the broken `default(/* TODO */ undefined)`
      // output is gone.
      expect(result.content).not.toContain("review default */ undefined");
    });

    it("jsonb default with arrow-function `() => \"'[]'\"` (array form) also works", async () => {
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("template")
        export class Template {
          @Column("jsonb", { default: () => "'[]'" })
          body!: unknown[];
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/template.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain(".default(sql`'[]'`)");
    });

    it("arrow-function default with explicit cast `() => \"'{}'::jsonb\"` preserves the cast verbatim", async () => {
      // Some apps spell the cast explicitly; the codemod should NOT
      // re-cast (the user wrote the SQL they want).
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("config")
        export class Config {
          @Column("jsonb", { default: () => "'{}'::jsonb" })
          opts!: Record<string, unknown>;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/config.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain(".default(sql`'{}'::jsonb`)");
    });

    it('arrow-function default with SQL function call `() => "now()"` works on non-jsonb columns too', async () => {
      // The arrow-fn idiom isn't jsonb-specific — `() => "now()"` is
      // a common timestamp default. The fix generalizes.
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("event")
        export class Event {
          @Column("timestamp", { default: () => "now()" })
          occurredAt!: Date;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/event.ts" });
      expect(result.ok).toBe(true);
      expect(result.content).toContain(".default(sql`now()`)");
      expect(result.content).toContain('import { sql } from "drizzle-orm"');
    });

    it("non-arrow-fn raw default falls through to existing TODO marker", async () => {
      // Anything more exotic than `() => "<string>"` (e.g. an arrow
      // body that's not a single string literal, or a function with
      // parameters) shouldn't be force-fit into a sql template;
      // existing TODO behavior preserves the user's manual review
      // path.
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("weird")
        export class Weird {
          @Column("varchar", { default: () => 42 })
          name!: string;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/weird.ts" });
      expect(result.ok).toBe(true);
      // Should fall through to the existing TODO behavior — no sql
      // import, no broken-but-syntactic emission of \`sql\`42\``.
      expect(result.content).not.toContain("import { sql }");
      expect(result.content).toContain("TODO[ship-api migrate-orm]: review default");
    });

    it("non-jsonb column with object default falls through to legacy (TODO marker, no sql import)", async () => {
      // varchar with an object default is unusual but possible; we
      // shouldn't emit a sql template for non-jsonb columns. Falls
      // through to the existing renderDefaultValue which TODOs the
      // unhandled shape.
      const source = `
        import { Column, Entity } from "typeorm";

        @Entity("weird")
        export class Weird {
          @Column("varchar", { default: { malformed: true } })
          name!: string;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/weird.ts" });
      expect(result.ok).toBe(true);
      // No sql import for this case (the value isn't jsonb-bound).
      expect(result.content).not.toContain("import { sql }");
    });
  });

  describe("transformText — inheritance walk", () => {
    it("merges inherited @Column / @PrimaryGeneratedColumn / audit-trio fields from a same-file abstract base", async () => {
      const source = `
        import { Column, Entity, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, DeleteDateColumn } from "typeorm";

        export abstract class TenantScopedEntity {
          @PrimaryGeneratedColumn("uuid")
          id!: string;

          @Column("varchar", { default: "default" })
          tenantId!: string;

          @CreateDateColumn() createdAt!: Date;
          @UpdateDateColumn() updatedAt!: Date;
          @DeleteDateColumn() deletedAt!: Date;
        }

        @Entity("proposal")
        export class Proposal extends TenantScopedEntity {
          @Column("varchar")
          title!: string;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/proposal.ts" });
      expect(result.ok).toBe(true);

      // Inherited fields land in the generated table.
      expect(result.content).toContain('id: uuid("id").primaryKey().defaultRandom()');
      expect(result.content).toContain(
        'tenantId: varchar("tenant_id", { length: 255 }).notNull().default("default")',
      );
      // Inherited audit trio collapses to ...baseFields.
      expect(result.content).toContain("...baseFields,");
      // Child's own field still present.
      expect(result.content).toContain('title: varchar("title", { length: 255 }).notNull()');
      // Header announces the inheritance source.
      expect(result.content).toContain("Inherits TenantScopedEntity");
    });

    it("walks two-level inheritance (X extends Y extends Z)", async () => {
      const source = `
        import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

        export abstract class Base {
          @PrimaryGeneratedColumn("uuid")
          id!: string;
        }

        export abstract class Tenanted extends Base {
          @Column("varchar")
          tenantId!: string;
        }

        @Entity("doc")
        export class Document extends Tenanted {
          @Column("varchar")
          title!: string;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/doc.ts" });
      expect(result.ok).toBe(true);
      // All three levels' fields land.
      expect(result.content).toContain('id: uuid("id").primaryKey().defaultRandom()');
      expect(result.content).toContain('tenantId: varchar("tenant_id", { length: 255 }).notNull()');
      expect(result.content).toContain('title: varchar("title", { length: 255 }).notNull()');
      // Both ancestor levels announced in header.
      expect(result.content).toContain("Inherits Tenanted");
      expect(result.content).toContain("Inherits Base");
    });

    it("silently skips framework-only base classes (e.g. AbstractEntity from @sixthsummit/ship-api)", async () => {
      const source = `
        import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
        import AbstractEntity from "@sixthsummit/ship-api/app/entity/AbstractEntity";

        @Entity("widget")
        export class Widget extends AbstractEntity {
          @PrimaryGeneratedColumn("uuid")
          id!: string;
          @Column("varchar")
          name!: string;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/widget.ts" });
      expect(result.ok).toBe(true);
      // Framework-only parent: no inheritance header, no TODO from the
      // walk (the user already knows AbstractEntity is v3-only).
      expect(result.content).not.toContain("Inherits AbstractEntity");
      expect(result.content).not.toContain("could not be resolved");
      // Child's own fields are still rendered.
      expect(result.content).toContain('id: uuid("id").primaryKey().defaultRandom()');
      expect(result.content).toContain('name: varchar("name", { length: 255 }).notNull()');
    });

    it("emits a TODO when the parent class import cannot be resolved", async () => {
      const source = `
        import { Column, Entity } from "typeorm";
        import { MissingBase } from "./does-not-exist";

        @Entity("thing")
        export class Thing extends MissingBase {
          @Column("varchar")
          title!: string;
        }
      `;
      const result = await transformText(source, { fileName: "/tmp/thing.ts" });
      expect(result.ok).toBe(true);
      // TODO surfaced; nothing inherited.
      expect(result.content).toContain("TODO[ship-api migrate-orm]");
      expect(result.content).toContain("MissingBase");
      expect(result.content).toMatch(/could not be resolved|inherited fields not merged/);
      // Child's own fields still rendered.
      expect(result.content).toContain('title: varchar("title", { length: 255 }).notNull()');
    });
  });

  // Synthetic regression inputs cover inheritance, decimal/JSON defaults, and permission hints.
  describe("regression — synthetic-inheritance fixture (commits 2/3/4 cumulative)", () => {
    const fixtureDir = path.resolve(__dirname, "..", "__fixtures__", "synthetic-inheritance");

    it("transforms Sample.entity.ts: inheritance walk + decimal + jsonb default + filename rule", async () => {
      const entityPath = path.join(fixtureDir, "sample.entity.ts");
      const source = await readFile(entityPath, "utf8");
      const result = await transformText(source, { fileName: entityPath });
      expect(result.ok).toBe(true);
      const out = result.content;

      // — F2.1 inheritance walk —
      // FixtureBase declares 5 fields; all should land in the table.
      expect(out).toContain("Inherits FixtureBase");
      expect(out).toContain('id: uuid("id").primaryKey().defaultRandom()');
      expect(out).toContain(
        'scopeId: varchar("scope_id", { length: 255 }).notNull().default("default")',
      );
      // Audit trio collapses to ...baseFields.
      expect(out).toContain("...baseFields,");
      expect(out).toContain('import { baseFields } from "@sixthsummit/ship-api/app/db/baseFields"');

      // — F2.2 decimal precision/scale —
      expect(out).toContain(
        'amount: decimal("amount", { precision: 10, scale: 2 }).notNull().default(0)',
      );
      expect(out).toContain(
        'ratio: decimal("ratio", { precision: 5, scale: 2 }).notNull().default(0)',
      );
      expect(out).toContain(
        'balance: decimal("balance", { precision: 10, scale: 2 }).notNull().default(0)',
      );

      // — F2.3 jsonb default —
      expect(out).toContain(".default(sql`'[]'::jsonb`)");
      expect(out).toContain('import { sql } from "drizzle-orm"');

      // Child fields still present.
      expect(out).toContain('label: varchar("label", { length: 255 }).notNull()');
      expect(out).toContain(
        'status: varchar("status", { length: 255 }).notNull().default("draft")',
      );
      expect(out).toContain('unit: varchar("unit", { length: 255 }).notNull().default("cm")');
      // Nullable column doesn't get .notNull().
      expect(out).toContain('memo: varchar("memo", { length: 255 }),');

      // — Type aliases —
      expect(out).toContain("export type Sample = typeof sample.$inferSelect");
      expect(out).toContain("export type NewSample = typeof sample.$inferInsert");
    });

    it("entityToOutputPath rule: sample.entity.ts → sample.drizzle.ts", () => {
      // — F2.7 filename rule, applied to the fixture path —
      const entityPath = path.join(fixtureDir, "sample.entity.ts");
      const expected = path.join(fixtureDir, "sample.drizzle.ts");
      expect(entityToOutputPath(entityPath)).toBe(expected);
    });

    it("analyzes sample.controller.ts: every @HasPermission surfaces as kind=hint", async () => {
      const controllerPath = path.join(fixtureDir, "sample.controller.ts");
      const report = await analyzeFile(controllerPath);

      const hints = report.findings.filter((f) => f.decorator === "HasPermission");
      // — F2.5 — 6 controller methods carry @HasPermission. All must
      // be classified as "hint" (not "unknown" — the pre-fix behavior).
      expect(hints).toHaveLength(6);
      for (const h of hints) {
        expect(h.kind).toBe("hint");
        expect(h.note).toMatch(/requirePermission/);
        expect(h.note).toContain("routes.ts");
      }

      // The 5 slug-bearing decorators must include the slug verbatim
      // in the hint message.
      const slugMessages = hints.map((h) => h.note).join("\n");
      expect(slugMessages).toContain('"samples:create"');
      expect(slugMessages).toContain('"samples:read"');
      expect(slugMessages).toContain('"samples:update"');
      expect(slugMessages).toContain('"samples:delete"');

      // Hints land in the report's per-kind tally — NOT in unknown.
      expect(report.counts.hint).toBe(6);
      expect(report.counts.unknown).toBe(0);
    });
  });
});
