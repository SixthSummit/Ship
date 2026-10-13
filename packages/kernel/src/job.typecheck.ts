/** Type-level CI contract for job declarations, enqueuers and runtime bindings. */
import { z } from "zod";
import { permission } from "./access.js";
import { defineApp } from "./application.js";
import { dependency, effectDependency } from "./dependency.js";
import {
  defineJob,
  defineJobCleanup,
  defineJobManagement,
  type JobBackend,
  type JobEnqueuer,
  jobBackendDependency,
  jobDependency,
  type LockProvider,
  lockProviderDependency,
} from "./job.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { defineOutbox, outboxIntent } from "./outbox.js";
import { valueProvider } from "./provider.js";
import { startJobRuntime } from "./runtime.js";

interface Notifier {
  send(message: { readonly recipient: string }): Promise<void>;
}
const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const repository = dependency<{ list(): readonly string[] }>("reports.repository");

const digest = defineJob({
  id: "reports.digest",
  input: z.object({ tenantId: z.string().min(1) }),
  trigger: { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
  concurrency: {
    mode: "single-runner",
    // The key function receives the validated payload.
    key: (input) => input.tenantId,
  },
  retry: { attempts: 3, backoff: { initialMs: 100 } },
  transaction: "none",
  dependencies: { repository, notifier },
  effects: [notifier],
  handler: async ({ input, services, context }) => {
    input.tenantId satisfies string;
    services.repository.list() satisfies readonly string[];
    // Jobs always run as system actors; the context is narrowed accordingly.
    context.actor.kind satisfies "system";
    await services.notifier.send({ recipient: input.tenantId });
    return { digested: true };
  },
});
digest.id satisfies "reports.digest";
digest.access.kind satisfies "system";
digest.transport.kind satisfies "job";
digest.job.concurrency.mode satisfies "single-runner" | "parallel";

defineJob({
  id: "reports.invalid",
  input: z.object({ tenantId: z.string() }),
  trigger: { kind: "enqueue" },
  concurrency: { mode: "parallel" },
  retry: { attempts: 1, backoff: { initialMs: 1 } },
  transaction: "none",
  dependencies: {},
  // @ts-expect-error the payload type follows the declared schema
  handler: ({ input }) => input.missing,
});

defineJob({
  id: "reports.no-schedule-tz",
  input: z.object({}),
  // @ts-expect-error schedule triggers require tz
  trigger: { kind: "schedule", cron: "0 * * * *" },
  concurrency: { mode: "parallel" },
  retry: { attempts: 1, backoff: { initialMs: 1 } },
  transaction: "none",
  dependencies: {},
  handler: () => undefined,
});

const render = defineJob({
  id: "reports.render",
  input: z.object({ tenantId: z.string(), pages: z.number().int() }),
  trigger: { kind: "http", access: permission("reports:render") },
  concurrency: { mode: "parallel", max: 4 },
  retry: { attempts: 2, backoff: { initialMs: 50, multiplier: 3, maxMs: 1_000 } },
  transaction: "none",
  dependencies: { digest: jobDependency(digest) },
  handler: async ({ services }) => {
    services.digest satisfies JobEnqueuer<typeof digest.input.payload>;
    await services.digest.enqueue({ tenantId: "acme" }, { dedupeKey: "acme" });
    // @ts-expect-error enqueued payloads follow the target job's schema input type
    await services.digest.enqueue({ tenantId: 1 });
    return undefined;
  },
});

defineOperation({
  id: "reports.tooling",
  input: {},
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: permission("reports:admin"),
  transaction: "none",
  dependencies: { jobs: jobBackendDependency(), lock: lockProviderDependency() },
  handler: ({ services }) => {
    services.jobs satisfies JobBackend;
    services.lock satisfies LockProvider;
    return { ok: true as const };
  },
});

const management = defineJobManagement({ prefix: "jobs" });
management.listFailed.id satisfies "jobs.list-failed";
management.health.id satisfies "jobs.health";

const outbox = defineOutbox({
  id: "reports.outbox",
  retention: { completedMs: 1, deadLetteredMs: 1 },
  intents: {
    notify: outboxIntent({
      payload: z.object({ recipient: z.string() }),
      effect: notifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});
const cleanup = defineJobCleanup({
  trigger: { kind: "interval", everyMs: 60_000 },
  outboxes: [outbox],
});
cleanup.id satisfies string;
cleanup.job.trigger.kind satisfies "schedule" | "interval" | "enqueue" | "http";

declare const backend: JobBackend;
declare const lock: LockProvider;
const app = defineApp({
  id: "jobs-typecheck",
  modules: [
    defineModule({
      id: "reports",
      operations: [digest, render],
      providers: [
        valueProvider(jobBackendDependency(), backend),
        valueProvider(lockProviderDependency(), lock),
        valueProvider(repository, { list: () => [] }),
        valueProvider(notifier, { send: async () => undefined }),
      ],
      imports: [],
      exports: [],
    }),
  ],
  runtime: { workers: { mode: "worker", budget: 4 } },
});
app.runtime.workers?.mode satisfies "api" | "worker" | "all" | undefined;
app.graph.jobs[0]?.concurrency.keyed satisfies boolean | undefined;
app.operationById["reports.digest"].job.id satisfies "reports.digest";

async function verifyRuntime(): Promise<void> {
  const runtime = await startJobRuntime(app, { backend, mode: "all" });
  runtime.scheduled satisfies readonly string[];
  await runtime.stop();
}
void verifyRuntime;
