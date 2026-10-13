import type {
  IdempotencyStore,
  OutboxBackend,
  UnitOfWork,
  WebhookEventStore,
} from "@sixthsummit/ship-core";
import { cacheInvalidationOutbox, defineRealtimePublicationOutbox } from "@sixthsummit/ship-core";
import {
  createDrizzleIdempotencyStore,
  createDrizzleOutbox,
  createDrizzleUnitOfWork,
  createDrizzleWebhookEventStore,
  createTenantRepository,
  type DrizzleTransaction,
  type TenantRepositoryFactory,
  tenantPredicate,
} from "@sixthsummit/ship-drizzle";
// This file is the consumer-owned data-access boundary; raw operators do not escape it.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { publishedChannels } from "./channels.js";
import { paymentsOutbox, reportsOutbox } from "./outbox.js";
import {
  idempotencyKeys,
  type portfolioSchema,
  projects,
  reportRequests,
  reportsOutboxTable,
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

export interface PortfolioRepository {
  summarize(query: PortfolioSummaryQuery): Promise<readonly PortfolioSummaryRow[]>;
  recordReportRequest(request: ReportRequest): Promise<{ readonly id: string }>;
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

export function createIdempotencyStore(
  database: NodePgDatabase<typeof portfolioSchema>,
): IdempotencyStore {
  return createDrizzleIdempotencyStore({ database, table: idempotencyKeys });
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
      });
    },
  });
}
