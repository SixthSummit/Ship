// Compile-only public contract checks. This file is included by tsconfig.check.json.
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  defineAuditColumns,
  defineRepositoryProjections,
  defineSoftDeleteColumns,
  offsetPage,
  resolveOffsetPagination,
} from "./index.js";

const records = pgTable("typed_repository_records", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  secret: text("secret").notNull(),
  createdDate: timestamp("createdDate", { withTimezone: true }).notNull(),
  updatedDate: timestamp("updatedDate", { withTimezone: true }).notNull(),
  deletedDate: timestamp("deletedDate", { withTimezone: true }),
  createdByUserId: uuid("createdByUserId"),
  updatedByUserId: uuid("updatedByUserId"),
});

const audit = defineAuditColumns(records, {
  createdAt: "createdDate",
  updatedAt: "updatedDate",
  createdBy: "createdByUserId",
  updatedBy: "updatedByUserId",
});
const softDelete = defineSoftDeleteColumns(records, {
  deletedAt: "deletedDate",
  updatedAt: "updatedDate",
  actor: "updatedByUserId",
});
const projections = defineRepositoryProjections({
  summary: async (id: string) => ({ id, title: "Summary" }),
  detail: async (id: string, includeSecret: boolean) => ({
    id,
    title: "Detail",
    ...(includeSecret ? { secret: "classified" } : {}),
  }),
});

async function verifyRepositoryPrimitiveTypes(): Promise<void> {
  const at = new Date();
  const actorId = "11111111-1111-4111-8111-111111111111";
  audit.created({ at, actorId }) satisfies Readonly<Partial<typeof records.$inferInsert>>;
  audit.updated({ at, actorId }) satisfies Readonly<Partial<typeof records.$inferInsert>>;
  softDelete.deletedValues({ at, actorId }) satisfies Readonly<
    Partial<typeof records.$inferInsert>
  >;

  const summary = await projections.run("summary", "record-1");
  const title: string = summary.title;
  // @ts-expect-error summary intentionally cannot expose detail-only data
  summary.secret;
  await projections.run("detail", "record-1", true);
  // @ts-expect-error projection names are a closed set
  await projections.run("everything", "record-1");
  // @ts-expect-error arguments remain specific to the chosen projection
  await projections.run("detail", "record-1");

  const window = resolveOffsetPagination({ limit: 10, offset: 20 });
  const page = offsetPage([summary], 30, window);
  const total: number = page.total;
  // @ts-expect-error page results are immutable
  page.items.push(summary);
  title satisfies string;
  total satisfies number;
}

// @ts-expect-error audit roles must reference real TypeScript column names
defineAuditColumns(records, { createdAt: "missing", updatedAt: "updatedDate" });
// @ts-expect-error the soft-delete timestamp must be nullable
defineSoftDeleteColumns(records, { deletedAt: "createdDate" });
// @ts-expect-error configured actor columns preserve their input type
audit.updated({ at: new Date(), actorId: 42 });

void verifyRepositoryPrimitiveTypes;
