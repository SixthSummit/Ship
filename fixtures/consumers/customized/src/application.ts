import { contractSchema } from "@sixthsummit/ship-contract/schema";
import {
  type CacheBackend,
  cacheBackendDependency,
  createTenantScopeAuthority,
  defineApp,
  defineCacheInvalidationModule,
  defineJobCleanup,
  defineJobManagement,
  defineModule,
  defineOperation,
  defineOutboxDispatcher,
  defineRealtimePublicationModule,
  type IdempotencyStore,
  idempotencyStoreDependency,
  type JobBackend,
  jobBackendDependency,
  type LockProvider,
  lockProviderDependency,
  type MailInterceptor,
  type MailLedger,
  type MailProvider,
  mailLedgerDependency,
  mailProviderDependency,
  type OutboxBackend,
  operationError,
  operationFailure,
  outboxDependency,
  permission,
  REALTIME_PUBLICATION_MODULE_ID,
  type RealtimePublishBackend,
  TenantCapabilityError,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
  type WebhookEventStore,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { defineMailDelivery, defineMailPreview } from "@sixthsummit/ship-mail";
import { z } from "zod";
import {
  notificationDelivered,
  projectActivity,
  publishedChannels,
  reportRequested,
} from "./channels.js";
import type { PaymentEventSink, ReportNotifier } from "./effects.js";
import { defineReportJobs } from "./jobs.js";
import { reportsMailer } from "./mail.js";
import { paymentSink, paymentsOutbox, reportNotifier, reportsOutbox } from "./outbox.js";
import { type PortfolioCapabilities, workItemStates } from "./repository.js";
import {
  createMessagingWebhooks,
  createPaymentWebhooks,
  type WebhookSecrets,
  webhookEvents,
} from "./webhooks.js";

const tenantParamsSchema = contractSchema(z.object({ tenantId: z.string().trim().min(1) }), {
  jsonSchema: {
    type: "object",
    required: ["tenantId"],
    properties: { tenantId: { type: "string", minLength: 1 } },
  },
});
const summaryQuerySchema = contractSchema(
  z.object({
    states: z.array(z.enum(workItemStates)).min(1),
    minimumEffort: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().positive().max(25).default(10),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["states"],
      properties: {
        states: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: [...workItemStates] },
        },
        minimumEffort: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
    },
  },
);
const summarySchema = contractSchema(
  z.object({
    projects: z.array(
      z.object({
        projectId: z.string().uuid(),
        projectName: z.string(),
        itemCount: z.number().int().nonnegative(),
        totalEffort: z.number().int().nonnegative(),
        latestActivity: z.string().datetime(),
      }),
    ),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["projects"],
      properties: {
        projects: {
          type: "array",
          items: {
            type: "object",
            required: ["projectId", "projectName", "itemCount", "totalEffort", "latestActivity"],
            properties: {
              projectId: { type: "string", format: "uuid" },
              projectName: { type: "string" },
              itemCount: { type: "integer", minimum: 0 },
              totalEffort: { type: "integer", minimum: 0 },
              latestActivity: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
);
const notifyBodySchema = contractSchema(
  z.object({ recipient: z.string().email(), subject: z.string().trim().min(1).max(120) }),
  {
    jsonSchema: {
      type: "object",
      required: ["recipient", "subject"],
      properties: {
        recipient: { type: "string", format: "email" },
        subject: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
  },
);
const notificationAcceptedSchema = contractSchema(
  z.object({ accepted: z.literal(true), adapter: z.string() }),
  {
    jsonSchema: {
      type: "object",
      required: ["accepted", "adapter"],
      properties: {
        accepted: { type: "boolean", const: true },
        adapter: { type: "string" },
      },
    },
  },
);
const emailBodySchema = contractSchema(
  z.object({
    recipient: z.string().email(),
    period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    projectCount: z.number().int().nonnegative(),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["recipient", "period", "projectCount"],
      properties: {
        recipient: { type: "string", format: "email" },
        period: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        projectCount: { type: "integer", minimum: 0 },
      },
    },
  },
);
const emailAcceptedSchema = contractSchema(
  z.object({ accepted: z.literal(true), sendId: z.string(), deduplicated: z.boolean() }),
  {
    jsonSchema: {
      type: "object",
      required: ["accepted", "sendId", "deduplicated"],
      properties: {
        accepted: { type: "boolean", const: true },
        sendId: { type: "string" },
        deduplicated: { type: "boolean" },
      },
    },
  },
);
const requestBodySchema = contractSchema(
  z.object({
    requestKey: z.string().trim().min(1).max(64),
    recipient: z.string().email(),
    subject: z.string().trim().min(1).max(120),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["requestKey", "recipient", "subject"],
      properties: {
        requestKey: { type: "string", minLength: 1, maxLength: 64 },
        recipient: { type: "string", format: "email" },
        subject: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
  },
);
const progressBodySchema = contractSchema(
  z.object({ steps: z.number().int().min(1).max(20), failAtStep: z.number().int().optional() }),
  {
    jsonSchema: {
      type: "object",
      required: ["steps"],
      properties: {
        steps: { type: "integer", minimum: 1, maximum: 20 },
        failAtStep: { type: "integer" },
      },
    },
  },
);
const progressFrameSchema = contractSchema(
  z.object({
    step: z.number().int().positive(),
    total: z.number().int().positive(),
    percent: z.number().int().min(0).max(100),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["step", "total", "percent"],
      properties: {
        step: { type: "integer", minimum: 1 },
        total: { type: "integer", minimum: 1 },
        percent: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
  },
);
const requestRecordedSchema = contractSchema(
  z.object({ requestId: z.string().uuid(), queued: z.boolean() }),
  {
    jsonSchema: {
      type: "object",
      required: ["requestId", "queued"],
      properties: { requestId: { type: "string", format: "uuid" }, queued: { type: "boolean" } },
    },
  },
);
const progressCompleteSchema = contractSchema(
  z.object({ tenantId: z.string(), steps: z.number().int().nonnegative() }),
  {
    jsonSchema: {
      type: "object",
      required: ["tenantId", "steps"],
      properties: { tenantId: { type: "string" }, steps: { type: "integer", minimum: 0 } },
    },
  },
);
const renderStepFailed = operationError({
  code: "RENDER_STEP_FAILED",
  status: 409,
  message: "Report rendering failed",
  details: contractSchema(z.object({ step: z.number().int() }), {
    jsonSchema: {
      type: "object",
      required: ["step"],
      properties: { step: { type: "integer" } },
    },
  }),
});
const tenantDeniedDetailsSchema = contractSchema(z.object({ tenantId: z.string() }), {
  jsonSchema: {
    type: "object",
    required: ["tenantId"],
    properties: { tenantId: { type: "string" } },
  },
});

export { notificationDelivered, projectActivity, publishedChannels, reportRequested };

const tenantAccessDenied = operationError({
  code: "TENANT_ACCESS_DENIED",
  status: 403,
  message: "Tenant access denied",
  details: tenantDeniedDetailsSchema,
});
const mailQueueFull = operationError({
  code: "MAIL_QUEUE_FULL",
  status: 503,
  message: "Mail delivery queue is full; retry later",
});

const portfolioUnitOfWork = unitOfWorkDependency<PortfolioCapabilities>("database.portfolio");
const idempotencyStore = idempotencyStoreDependency("platform.idempotency");
const portfolioCache = cacheBackendDependency("platform.cache");
/** Tag shared by the cached tenant read and the write that invalidates it. */
export const PORTFOLIO_SUMMARY_TAG = "portfolio.summary";
export const DISPATCH_BATCH_SIZE = 25;
/**
 * Dispatch rounds per second each worker drives a dispatcher at. With the
 * adaptive runner (`startOutboxDispatchRunner`, 250 ms idle interval, 10 full
 * passes per cycle) one worker sustains about 25 rounds/s at a backlog, so
 * the declared capacity (25 x 25 = 625/s) covers the expected 500/s.
 */
export const DISPATCH_ROUNDS_PER_SECOND = 25;
function createTenantPolicy(scheduledTenants: readonly string[]) {
  return createTenantScopeAuthority({
    id: "portfolio.tenant-policy",
    // Consumer-owned meaning: humans need a tenant permission; scheduled system
    // work may only touch tenants the application enrolled in the digest.
    authorize: ({ actor, tenantId }) =>
      actor.kind === "system"
        ? scheduledTenants.includes(String(tenantId))
        : (actor.permissions?.has(`tenant:${tenantId}`) ?? false),
  });
}

function createTenantAuthorizer(scheduledTenants: readonly string[]) {
  const tenantPolicy = createTenantPolicy(scheduledTenants);
  return async (
    tenantId: string,
    context: {
      readonly requestId: string;
      readonly actor?: Parameters<typeof tenantPolicy.issue>[0]["actor"];
    },
  ) => {
    if (!context.actor) {
      throw operationFailure(tenantAccessDenied, { details: { tenantId } });
    }
    try {
      return await tenantPolicy.issue({
        tenantId,
        requestId: context.requestId,
        actor: context.actor,
      });
    } catch (error) {
      if (error instanceof TenantCapabilityError) {
        throw operationFailure(tenantAccessDenied, { details: { tenantId } });
      }
      throw error;
    }
  };
}

export interface CustomizedInfrastructure {
  readonly unitOfWork: UnitOfWork<PortfolioCapabilities>;
  readonly notifier: ReportNotifier;
  readonly outbox: OutboxBackend;
  readonly idempotency: IdempotencyStore;
  readonly cache: CacheBackend;
  /** Durable storage for cache purge intents; one row per invalidated tag. */
  readonly cacheOutbox: OutboxBackend;
  /** Publish-only realtime backend; the gateway runs elsewhere. */
  readonly realtime: RealtimePublishBackend;
  /** Durable storage for publication intents recorded by write operations. */
  readonly realtimeOutbox: OutboxBackend;
  /** Ledger effect performed when a durably received payment webhook is dispatched. */
  readonly paymentSink: PaymentEventSink;
  readonly paymentsOutbox: OutboxBackend;
  /** Durable raw-event storage for enqueue-mode webhooks. */
  readonly webhookEvents: WebhookEventStore;
  readonly webhookSecrets: WebhookSecrets;
  readonly jobs: JobBackend;
  readonly locks: LockProvider;
  /** Transactional mail: the provider adapter, the send ledger and the non-production guard. */
  readonly mailProvider: MailProvider;
  readonly mailLedger: MailLedger;
  readonly mailInterceptor?: MailInterceptor;
  /** Tenants the scheduled digest job fans out to. */
  readonly scheduledTenants?: readonly string[];
  readonly digestRecipient?: string;
  /** Injectable clock for deterministic dispatcher and cleanup tests. */
  readonly clock?: () => Date;
}

export function createCustomizedApplication(infrastructure: CustomizedInfrastructure) {
  const { unitOfWork, notifier, outbox, idempotency, cache, cacheOutbox, realtime, jobs, locks } =
    infrastructure;
  const clock = infrastructure.clock ?? (() => new Date());
  const scheduledTenants = infrastructure.scheduledTenants ?? [];
  const authorizeTenant = createTenantAuthorizer(scheduledTenants);
  const payments = createPaymentWebhooks(infrastructure.webhookSecrets, portfolioUnitOfWork, clock);
  const messaging = createMessagingWebhooks(infrastructure.webhookSecrets);
  const paymentsDispatcher = defineOutboxDispatcher(paymentsOutbox, {
    batchSize: DISPATCH_BATCH_SIZE,
    lease: { ms: 30_000 },
    retry: { attempts: 5, backoff: { initialMs: 1_000, multiplier: 4, maxMs: 15 * 60_000 } },
    deadLetter: true,
    clock,
  });
  const summary = defineOperation({
    id: "portfolio.summary",
    transport: http.get("/tenants/:tenantId/portfolio"),
    input: { params: tenantParamsSchema, query: summaryQuerySchema },
    output: { 200: summarySchema },
    successStatus: 200,
    errors: [tenantAccessDenied],
    access: permission("portfolio:read"),
    transaction: "read",
    dependencies: { tx: portfolioUnitOfWork, cache: portfolioCache },
    // Keyed by the authentic tenant scope, so one tenant can never observe
    // another's summary, and by the query that shaped it.
    cache: {
      ttlMs: 30_000,
      scope: "tenant",
      tags: [PORTFOLIO_SUMMARY_TAG],
      tenant: ({ input, context }) => authorizeTenant(input.params.tenantId, context),
      vary: (input) => [`states:${[...input.query.states].sort().join(",")}`],
    },
    handler: async ({ input, services, context }) => {
      const scope = await authorizeTenant(input.params.tenantId, context);
      const rows = await services.tx.portfolio.forTenant(scope).summarize(input.query);
      return {
        projects: rows.map((row) => ({
          ...row,
          latestActivity: row.latestActivity.toISOString(),
        })),
      };
    },
  });
  const notify = defineOperation({
    id: "reports.notify",
    transport: http.post("/tenants/:tenantId/report-notifications"),
    input: { params: tenantParamsSchema, body: notifyBodySchema },
    output: { 202: notificationAcceptedSchema },
    successStatus: 202,
    errors: [tenantAccessDenied],
    access: permission("reports:notify"),
    transaction: "none",
    dependencies: { notifier: reportNotifier, delivered: notificationDelivered.publication },
    effects: [reportNotifier],
    publishes: [notificationDelivered],
    handler: async ({ input, services, context }) => {
      const scope = await authorizeTenant(input.params.tenantId, context);
      await services.notifier.send({
        tenantId: scope.tenantId,
        recipient: input.body.recipient,
        subject: input.body.subject,
        requestedBy: scope.actorId,
      });
      await services.delivered.publish(scope.actorId, {
        tenantId: scope.tenantId,
        recipient: input.body.recipient,
        subject: input.body.subject,
        adapter: services.notifier.adapter,
      });
      return { accepted: true as const, adapter: services.notifier.adapter };
    },
  });
  // Durable path: the request row and the delivery intent commit together; the
  // dispatcher performs the effect afterwards. The idempotency key lets a
  // client safely retry the POST without creating a second request.
  const request = defineOperation({
    id: "reports.request",
    transport: http.post("/tenants/:tenantId/report-requests"),
    input: { params: tenantParamsSchema, body: requestBodySchema },
    output: { 201: requestRecordedSchema },
    successStatus: 201,
    errors: [tenantAccessDenied],
    access: permission("reports:notify"),
    transaction: "write",
    dependencies: {
      tx: portfolioUnitOfWork,
      outbox: outboxDependency(reportsOutbox),
      requested: reportRequested.publication,
    },
    // Recording a request changes what the cached summary would return, so the
    // write commits a purge intent for the tag in the same transaction.
    invalidates: [PORTFOLIO_SUMMARY_TAG],
    // A write operation publishes through the realtime publication outbox: the
    // event commits with the request row and is delivered after commit.
    publishes: [reportRequested],
    idempotency: {
      key: (input) => `${input.params.tenantId}:${input.body.requestKey}`,
      windowMs: 24 * 60 * 60 * 1000,
      store: idempotencyStore,
    },
    handler: async ({ input, services, context }) => {
      const scope = await authorizeTenant(input.params.tenantId, context);
      const recorded = await services.tx.portfolio.forTenant(scope).recordReportRequest({
        recipient: input.body.recipient,
        subject: input.body.subject,
        requestedBy: scope.actorId,
      });
      const queued = await services.outbox.enqueue(
        "notify",
        {
          tenantId: scope.tenantId,
          recipient: input.body.recipient,
          subject: input.body.subject,
          requestedBy: scope.actorId,
        },
        { dedupeKey: recorded.id },
      );
      await services.requested.publish(
        scope.actorId,
        { requestId: recorded.id, tenantId: scope.tenantId, subject: input.body.subject },
        { dedupeKey: recorded.id },
      );
      return { requestId: recorded.id, queued: !queued.deduplicated };
    },
  });
  const dispatcher = defineOutboxDispatcher(reportsOutbox, {
    batchSize: DISPATCH_BATCH_SIZE,
    roundsPerSecond: DISPATCH_ROUNDS_PER_SECOND,
    lease: { ms: 30_000 },
    retry: { attempts: 5, backoff: { initialMs: 1_000, multiplier: 4, maxMs: 15 * 60_000 } },
    deadLetter: true,
    clock,
  });
  const cacheInvalidation = defineCacheInvalidationModule({
    cache,
    outbox: cacheOutbox,
    ...(infrastructure.clock ? { clock } : {}),
  });
  const realtimePublication = defineRealtimePublicationModule({
    channels: publishedChannels,
    realtime,
    outbox: infrastructure.realtimeOutbox,
    batchSize: DISPATCH_BATCH_SIZE,
    ...(infrastructure.clock ? { clock } : {}),
  });
  const progress = defineOperation({
    id: "reports.progress",
    transport: http.post("/tenants/:tenantId/report-progress", {
      response: {
        mode: "stream",
        framing: "sse",
        frame: progressFrameSchema,
        heartbeatMs: 15_000,
        maxDurationMs: 60_000,
        maxFrames: 100,
      },
    }),
    input: { params: tenantParamsSchema, body: progressBodySchema },
    output: { 200: progressCompleteSchema },
    successStatus: 200,
    errors: [tenantAccessDenied, renderStepFailed],
    access: permission("reports:notify"),
    transaction: "none",
    dependencies: {},
    handler: async ({ input, context, stream }) => {
      const scope = await authorizeTenant(input.params.tenantId, context);
      const total = input.body.steps;
      for (let step = 1; step <= total && !stream.signal.aborted; step += 1) {
        if (input.body.failAtStep === step) {
          throw operationFailure(renderStepFailed, { details: { step } });
        }
        await stream.emit({ step, total, percent: Math.round((step / total) * 100) });
      }
      return { tenantId: scope.tenantId, steps: total };
    },
  });
  // Transactional mail: `reports.email` enqueues `mail.deliver` through the
  // typed sender; the job renders, claims the ledger row and calls the
  // provider once per idempotency key. The interceptor is only bound outside
  // production so staging never emails a real customer.
  const mail = defineMailDelivery({
    mailers: [reportsMailer],
    ...(infrastructure.mailInterceptor ? { interceptor: infrastructure.mailInterceptor } : {}),
    clock,
  });
  const mailPreview = defineMailPreview({ mailers: [reportsMailer] });
  const email = defineOperation({
    id: "reports.email",
    transport: http.post("/tenants/:tenantId/report-emails"),
    input: { params: tenantParamsSchema, body: emailBodySchema },
    output: { 202: emailAcceptedSchema },
    successStatus: 202,
    errors: [tenantAccessDenied, mailQueueFull],
    access: permission("reports:notify"),
    transaction: "none",
    dependencies: { mail: mail.dependency },
    handler: async ({ input, services, context }) => {
      const scope = await authorizeTenant(input.params.tenantId, context);
      const sent = await services.mail.send(reportsMailer, "digestReady", {
        to: input.body.recipient,
        payload: {
          tenantId: scope.tenantId,
          period: input.body.period,
          projectCount: input.body.projectCount,
        },
        idempotencyKey: `digest-email:${scope.tenantId}:${input.body.period}:${input.body.recipient}`,
        tenantId: scope.tenantId,
      });
      if (!sent.accepted) throw operationFailure(mailQueueFull);
      return { accepted: true as const, sendId: sent.sendId, deduplicated: sent.deduplicated };
    },
  });
  const reportJobs = defineReportJobs({
    scheduledTenants,
    recipient: infrastructure.digestRecipient ?? "reports@example.test",
    authorizeTenant,
    tenantAccessDenied,
    clock,
  });
  // One retention sweep covers job runs and both outboxes; no outbox cleanup
  // operation is composed separately. The webhook event store keeps its own
  // `payments.webhook-cleanup` operation (`defineWebhookCleanup`), which the
  // job runner schedules alongside this sweep.
  const cleanup = defineJobCleanup({
    trigger: { kind: "schedule", cron: "30 3 * * *", tz: "UTC" },
    outboxes: [reportsOutbox, paymentsOutbox],
    clock,
  });
  const management = defineJobManagement({ clock });
  const portfolioModule = defineModule({
    id: "portfolio",
    operations: [summary],
    providers: [
      valueProvider(portfolioUnitOfWork, unitOfWork),
      valueProvider(portfolioCache, cache),
      valueProvider(jobBackendDependency(), jobs),
      valueProvider(lockProviderDependency(), locks),
    ],
    imports: [],
    exports: [
      portfolioUnitOfWork,
      portfolioCache,
      jobBackendDependency(),
      lockProviderDependency(),
    ],
    channels: [projectActivity],
  });
  const reportsModule = defineModule({
    id: "reports",
    operations: [
      notify,
      request,
      progress,
      email,
      ...dispatcher.operations,
      reportJobs.deliver,
      reportJobs.digest,
    ],
    providers: [
      valueProvider(reportNotifier, notifier),
      valueProvider(reportsOutbox.writer, outbox),
      valueProvider(idempotencyStore, idempotency),
    ],
    imports: ["portfolio", "ship-cache", REALTIME_PUBLICATION_MODULE_ID],
    exports: [idempotencyStore, reportsOutbox.writer],
    channels: [notificationDelivered, reportRequested],
    mailers: [reportsMailer],
  });
  const mailModule = defineModule({
    id: "mail",
    operations: [mail.job, ...mailPreview.operations],
    providers: [
      valueProvider(mailProviderDependency(), infrastructure.mailProvider),
      valueProvider(mailLedgerDependency(), infrastructure.mailLedger),
    ],
    imports: ["portfolio"],
    exports: [],
  });
  const paymentsModule = defineModule({
    id: "payments",
    operations: [
      payments.stripe.operation,
      payments.replay,
      payments.cleanup,
      ...paymentsDispatcher.operations,
    ],
    providers: [
      valueProvider(paymentSink, infrastructure.paymentSink),
      valueProvider(paymentsOutbox.writer, infrastructure.paymentsOutbox),
      valueProvider(webhookEvents, infrastructure.webhookEvents),
    ],
    imports: ["portfolio", "reports"],
    exports: [paymentsOutbox.writer],
  });
  const messagingModule = defineModule({
    id: "messaging",
    operations: [messaging.inboundSms.operation, messaging.smsStatus.operation],
    providers: [],
    imports: ["reports"],
    exports: [],
  });
  const jobsModule = defineModule({
    id: "jobs",
    operations: [cleanup, ...management.operations],
    providers: [],
    imports: ["portfolio", "reports", "payments"],
    exports: [],
  });
  return defineApp({
    id: "golden-customized",
    modules: [
      portfolioModule,
      reportsModule,
      cacheInvalidation,
      realtimePublication,
      paymentsModule,
      messagingModule,
      jobsModule,
      mailModule,
    ],
    runtime: { workers: { mode: "api" } },
  });
}
