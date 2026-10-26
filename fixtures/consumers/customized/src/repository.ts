import type { CredentialStore } from "@sixthsummit/ship-auth-credentials";
import { createDrizzleCredentialStore } from "@sixthsummit/ship-auth-credentials/drizzle";
import type {
  AttachmentLedger,
  IdempotencyStore,
  JobBackend,
  MailLedger,
  OutboxBackend,
  RichTextDocument,
  UnitOfWork,
  WebhookEventStore,
} from "@sixthsummit/ship-core";
import { cacheInvalidationOutbox, defineRealtimePublicationOutbox } from "@sixthsummit/ship-core";
import {
  createDrizzleAttachmentLedger,
  createDrizzleIdempotencyStore,
  createDrizzleJobBackend,
  createDrizzleMailLedger,
  createDrizzleOutbox,
  createDrizzleUnitOfWork,
  createDrizzleWebhookEventStore,
  createTenantRepository,
  type DrizzleTransaction,
  type TenantRepositoryFactory,
  tenantPredicate,
} from "@sixthsummit/ship-drizzle";
import { defineStoragePurgeOutbox } from "@sixthsummit/ship-storage";
// This file is the consumer-owned data-access boundary; raw operators do not escape it.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { publishedChannels } from "./channels.js";
import { paymentsOutbox, reportsOutbox } from "./outbox.js";
import {
  authTables,
  documents,
  idempotencyKeys,
  jobControl,
  jobRuns,
  jobState,
  mailSendsTable,
  type portfolioSchema,
  projects,
  reportRequests,
  reportsOutboxTable,
  storageIntents,
  storageObjects,
  storagePurges,
  webhookEventsTable,
  workItems,
} from "./schema.js";

export const workItemStates = ["open", "blocked", "done"] as const;
export type WorkItemState = (typeof workItemStates)[number];

export interface PortfolioSummaryQuery {
  readonly states: readonly WorkItemState[];
  readonly minimumEffort: number;
  readonly limit: number;
}

export interface PortfolioSummaryRow {
  readonly projectId: string;
  readonly projectName: string;
  readonly itemCount: number;
  readonly totalEffort: number;
  readonly latestActivity: Date;
}

export interface ReportRequest {
  readonly recipient: string;
  readonly subject: string;
  readonly requestedBy: string;
}

export interface DocumentRow {
  readonly id: string;
  readonly title: string;
  readonly body: RichTextDocument;
  readonly bodyText: string;
}

export interface DocumentUpsert {
  readonly id: string;
  readonly title: string;
  readonly body: RichTextDocument;
  readonly bodyText: string;
}

export interface PortfolioRepository {
  summarize(query: PortfolioSummaryQuery): Promise<readonly PortfolioSummaryRow[]>;
  recordReportRequest(request: ReportRequest): Promise<{ readonly id: string }>;
  upsertDocument(document: DocumentUpsert): Promise<void>;
  readDocument(documentId: string): Promise<DocumentRow | undefined>;
  deleteDocument(documentId: string): Promise<boolean>;
}

export interface PortfolioCapabilities {
  readonly portfolio: TenantRepositoryFactory<string, PortfolioRepository>;
}

export function createReportsOutbox(
  database: NodePgDatabase<typeof portfolioSchema>,
): OutboxBackend {
  return createDrizzleOutbox({ outbox: reportsOutbox, database, table: reportsOutboxTable });
}

/**
 * Cache purge intents share the outbox table: rows carry their outbox id, so
 * one table serves both the report notifications and the invalidations.
 */
export function createCacheInvalidationOutbox(
  database: NodePgDatabase<typeof portfolioSchema>,
): OutboxBackend {
  return createDrizzleOutbox({
    outbox: cacheInvalidationOutbox,
    database,
    table: reportsOutboxTable,
  });
}

/** Realtime publication intents share the same table under their own outbox id. */
export function createRealtimePublicationOutbox(
  database: NodePgDatabase<typeof portfolioSchema>,
): OutboxBackend {
  return createDrizzleOutbox({
    outbox: defineRealtimePublicationOutbox(publishedChannels),
    database,
    table: reportsOutboxTable,
  });
}

/** The payments outbox shares the framework outbox table; rows are partitioned by outbox id. */
export function createPaymentsOutbox(
  database: NodePgDatabase<typeof portfolioSchema>,
): OutboxBackend {
  return createDrizzleOutbox({ outbox: paymentsOutbox, database, table: reportsOutboxTable });
}

export function createWebhookEventStore(
  database: NodePgDatabase<typeof portfolioSchema>,
): WebhookEventStore {
  return createDrizzleWebhookEventStore({
    database,
    table: webhookEventsTable,
    outboxTable: reportsOutboxTable,
    idempotencyTable: idempotencyKeys,
  });
}

/**
 * The PostgreSQL job backend with the opt-in control table, so the ops
 * console can pause a job durably where every worker process sees it.
 */
export function createJobBackend(
  database: NodePgDatabase<typeof portfolioSchema>,
  options: { readonly pollIntervalMs?: number; readonly clock?: () => Date } = {},
): JobBackend & { readonly lockProvider: import("@sixthsummit/ship-core").LockProvider } {
  return createDrizzleJobBackend({
    database,
    table: jobRuns,
    stateTable: jobState,
    controlTable: jobControl,
    ...options,
  });
}

/**
 * Object purge intents share the outbox table too; the purge ledger rows live
 * in the three storage tables included in the migrations.
 */
export function createStoragePurgeOutbox(
  database: NodePgDatabase<typeof portfolioSchema>,
): OutboxBackend {
  return createDrizzleOutbox({
    outbox: defineStoragePurgeOutbox(),
    database,
    table: reportsOutboxTable,
  });
}

export function createAttachmentLedger(
  database: NodePgDatabase<typeof portfolioSchema>,
): AttachmentLedger {
  return createDrizzleAttachmentLedger({
    database,
    intents: storageIntents,
    objects: storageObjects,
    purges: storagePurges,
  });
}

export function createIdempotencyStore(
  database: NodePgDatabase<typeof portfolioSchema>,
): IdempotencyStore {
  return createDrizzleIdempotencyStore({ database, table: idempotencyKeys });
}

/** The credential store over the seven package-owned auth tables. */
export function createCredentialStore(
  database: NodePgDatabase<typeof portfolioSchema>,
): CredentialStore {
  return createDrizzleCredentialStore({ database, tables: authTables });
}

export function createMailLedger(database: NodePgDatabase<typeof portfolioSchema>): MailLedger {
  return createDrizzleMailLedger({ database, table: mailSendsTable });
}

export function createPortfolioUnitOfWork(
  database: NodePgDatabase<typeof portfolioSchema>,
): UnitOfWork<PortfolioCapabilities> {
  return createDrizzleUnitOfWork({
    id: "database.portfolio",
    database,
    create: (transaction) => ({ portfolio: createPortfolioRepository(transaction) }),
  });
}

function createPortfolioRepository(
  transaction: DrizzleTransaction<typeof portfolioSchema>,
): TenantRepositoryFactory<string, PortfolioRepository> {
  return createTenantRepository({
    id: "portfolio.projects",
    transaction,
    createScoped: ({ transaction: scopedTransaction, scope }) => {
      const itemCount = sql<number>`count(${workItems.id})::int`;
      const totalEffort = sql<number>`sum(${workItems.effort})::int`;
      const latestActivity = sql<Date>`max(${workItems.createdAt})`.mapWith(workItems.createdAt);
      return Object.freeze({
        summarize: async (query: PortfolioSummaryQuery) =>
          scopedTransaction
            .select({
              projectId: projects.id,
              projectName: projects.name,
              itemCount,
              totalEffort,
              latestActivity,
            })
            .from(projects)
            .innerJoin(workItems, eq(workItems.projectId, projects.id))
            .where(
              and(
                tenantPredicate(projects.tenantId, scope),
                inArray(workItems.state, [...query.states]),
                gte(workItems.effort, query.minimumEffort),
              ),
            )
            .groupBy(projects.id, projects.name)
            .orderBy(desc(totalEffort), asc(projects.name))
            .limit(query.limit),
        recordReportRequest: async (request: ReportRequest) => {
          const [row] = await scopedTransaction
            .insert(reportRequests)
            .values({ ...request, tenantId: scope.tenantId })
            .returning({ id: reportRequests.id });
          if (!row) throw new Error("report request insert returned no row");
          return { id: row.id };
        },
        upsertDocument: async (document: DocumentUpsert) => {
          await scopedTransaction
            .insert(documents)
            .values({ ...document, tenantId: scope.tenantId })
            .onConflictDoUpdate({
              target: documents.id,
              set: {
                title: document.title,
                body: document.body,
                bodyText: document.bodyText,
                updatedAt: sql`now()`,
              },
              // The conflict target is the primary key; the tenant predicate keeps
              // a colliding id from another tenant from being overwritten.
              setWhere: tenantPredicate(documents.tenantId, scope),
            });
        },
        readDocument: async (documentId: string) => {
          const [row] = await scopedTransaction
            .select({
              id: documents.id,
              title: documents.title,
              body: documents.body,
              bodyText: documents.bodyText,
            })
            .from(documents)
            .where(and(eq(documents.id, documentId), tenantPredicate(documents.tenantId, scope)))
            .limit(1);
          return row ? { ...row, body: row.body as RichTextDocument } : undefined;
        },
        deleteDocument: async (documentId: string) => {
          const deleted = await scopedTransaction
            .delete(documents)
            .where(and(eq(documents.id, documentId), tenantPredicate(documents.tenantId, scope)))
            .returning({ id: documents.id });
          return deleted.length > 0;
        },
      });
    },
  });
}
