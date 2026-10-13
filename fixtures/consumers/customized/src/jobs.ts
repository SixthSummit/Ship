import { contractSchema } from "@sixthsummit/ship-contract/schema";
import {
  defineJob,
  jobDependency,
  type OperationContextForAccess,
  type OperationErrorDefinition,
  outboxDependency,
  type SystemAccess,
  type TenantScope,
  unitOfWorkDependency,
} from "@sixthsummit/ship-core";
import { z } from "zod";
import { reportsOutbox } from "./outbox.js";
import type { PortfolioCapabilities } from "./repository.js";

const portfolioUnitOfWork = unitOfWorkDependency<PortfolioCapabilities>("database.portfolio");

const deliverInputSchema = contractSchema(
  z.object({
    tenantId: z.string().trim().min(1),
    period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["tenantId", "period"],
      properties: {
        tenantId: { type: "string", minLength: 1 },
        period: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
    },
  },
);
const digestInputSchema = contractSchema(z.object({}), {
  jsonSchema: { type: "object", additionalProperties: false, properties: {} },
});

export interface ReportJobOptions {
  /** Tenants the scheduled digest fans out to; the consumer owns this policy. */
  readonly scheduledTenants: readonly string[];
  readonly recipient: string;
  /** Re-authorizes the tenant for this invocation; system actors get no implicit access. */
  readonly authorizeTenant: (
    tenantId: string,
    context: OperationContextForAccess<SystemAccess>,
  ) => Promise<TenantScope<string>>;
  /** The declared failure `authorizeTenant` raises; a refused tenant is final, never retried. */
  readonly tenantAccessDenied: OperationErrorDefinition;
  readonly clock: () => Date;
}

/**
 * Two declared jobs: a keyed single-runner digest that runs on a schedule and
 * enqueues one delivery per tenant, and the enqueued delivery that records a
 * report request through the unit of work and enqueues the outbox intent in
 * the same transaction. Both run as system actors; tenant authorization is
 * re-done per run.
 */
export function defineReportJobs(options: ReportJobOptions) {
  const deliver = defineJob({
    id: "reports.deliver",
    input: deliverInputSchema,
    trigger: { kind: "enqueue" },
    concurrency: { mode: "single-runner", max: 4, key: (input) => input.tenantId },
    retry: { attempts: 3, backoff: { initialMs: 1_000, multiplier: 4, maxMs: 60_000 } },
    retention: { completedMs: 24 * 60 * 60 * 1000, deadLetteredMs: 7 * 24 * 60 * 60 * 1000 },
    transaction: "write",
    dependencies: { tx: portfolioUnitOfWork, outbox: outboxDependency(reportsOutbox) },
    errors: [options.tenantAccessDenied],
    handler: async ({ input, services, context }) => {
      const scope = await options.authorizeTenant(input.tenantId, context);
      const subject = `Digest for ${input.period}`;
      const recorded = await services.tx.portfolio.forTenant(scope).recordReportRequest({
        recipient: options.recipient,
        subject,
        requestedBy: context.actor.id,
      });
      const queued = await services.outbox.enqueue(
        "notify",
        {
          tenantId: scope.tenantId,
          recipient: options.recipient,
          subject,
          requestedBy: context.actor.id,
        },
        { dedupeKey: `digest:${scope.tenantId}:${input.period}` },
      );
      return { requestId: recorded.id, queued: !queued.deduplicated };
    },
  });

  const digest = defineJob({
    id: "reports.digest",
    input: digestInputSchema,
    trigger: { kind: "schedule", cron: "0 6 * * *", tz: "UTC" },
    concurrency: { mode: "single-runner", key: () => "digest" },
    retry: { attempts: 2, backoff: { initialMs: 5_000 } },
    transaction: "none",
    dependencies: { deliver: jobDependency(deliver) },
    handler: async ({ services }) => {
      const period = options.clock().toISOString().slice(0, 10);
      const enqueued: string[] = [];
      for (const tenantId of options.scheduledTenants) {
        const result = await services.deliver.enqueue(
          { tenantId, period },
          { dedupeKey: `${tenantId}:${period}` },
        );
        if (result.accepted && !result.deduplicated) enqueued.push(result.runId);
      }
      return { period, enqueued };
    },
  });

  return { deliver, digest };
}
