import type { JobBackend, JobIntrospection, JobRunStatus } from "@sixthsummit/ship-core";
import {
  defineOperation,
  jobBackendDependency,
  jobIntrospection,
  jobRunNotFound,
  operationFailure,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { consoleCapabilityUnavailable, consoleJobNotFound } from "./errors.js";
import { consoleAccess } from "./permission.js";
import {
  DEFAULT_LIST_LIMIT,
  declarationSummary,
  jobCapabilitiesSchema,
  jobOverviewEntrySchema,
  limitQuery,
  runView,
  runViewSchema,
} from "./views.js";

export interface ConsolePanelOptions<TPrefix extends string = string> {
  /** Operation id prefix; the owning module id. */
  readonly prefix: TPrefix;
  /** HTTP path prefix every console route is mounted under. */
  readonly basePath: string;
  readonly clock: () => Date;
}

const RUN_STATUSES = [
  "waiting",
  "delayed",
  "active",
  "completed",
  "failed",
  "discarded",
] as const satisfies readonly JobRunStatus[];

const overviewOutput = z.object({
  capabilities: jobCapabilitiesSchema,
  jobs: z.array(jobOverviewEntrySchema),
});
const runsQuery = z.object({
  jobId: z.string().min(1).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: limitQuery,
});
const runsOutput = z.object({ runs: z.array(runViewSchema) });
const runQuery = z.object({ runId: z.string().min(1) });
const runOutput = z.object({ run: runViewSchema });
const runIdBody = z.object({ runId: z.string().min(1) });
const discardBody = z.object({ runId: z.string().min(1), reason: z.string().min(1) });
const retryAllBody = z.object({
  jobId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
const retryAllOutput = z.object({ retried: z.number().int(), runIds: z.array(z.string()) });
const jobIdBody = z.object({ jobId: z.string().min(1) });
const pausedOutput = z.object({ jobId: z.string(), paused: z.boolean() });

/** Resolves the introspection capability or fails the operation with a declared 501. */
export function requireIntrospection(backend: JobBackend, capability: string): JobIntrospection {
  const introspection = jobIntrospection(backend);
  if (!introspection) {
    throw operationFailure(consoleCapabilityUnavailable, {
      details: { capability, adapter: backend.adapter },
    });
  }
  return introspection;
}

export function jobCapabilities(backend: JobBackend) {
  const introspection = jobIntrospection(backend);
  return {
    adapter: backend.adapter,
    runs: introspection !== undefined,
    schedules: introspection !== undefined,
    pause: typeof introspection?.pause === "function" && typeof introspection.resume === "function",
  };
}

/**
 * The jobs panel: per-queue depth, running, failed and dead-lettered counts,
 * run listing and detail, retry, discard, bulk retry, and pause/resume where
 * the backend supports it. Every operation binds the raw job backend and is
 * gated by `console.operate`.
 */
export function defineConsoleJobOperations<const TPrefix extends string = string>(
  options: ConsolePanelOptions<TPrefix>,
) {
  const { prefix, basePath, clock } = options;
  const backend = jobBackendDependency();

  const overview = defineOperation({
    id: `${prefix}.jobs.overview` as const,
    transport: http.get(`${basePath}/jobs`),
    input: {},
    output: { 200: overviewOutput },
    successStatus: 200,
    errors: [],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ services }) => {
      const introspection = jobIntrospection(services.jobs);
      const declarations = new Map(
        (introspection?.declarations() ?? []).map((item) => [item.id, item]),
      );
      const paused = new Set(introspection ? await introspection.listPaused() : []);
      const health = await services.jobs.health(clock());
      const ids = [
        ...new Set([...declarations.keys(), ...health.jobs.map((entry) => entry.jobId)]),
      ].sort();
      return {
        capabilities: jobCapabilities(services.jobs),
        jobs: ids.map((jobId) => {
          const declaration = declarations.get(jobId);
          const entry = health.jobs.find((item) => item.jobId === jobId);
          return {
            jobId,
            declared: declaration !== undefined,
            ...(declaration ? declarationSummary(declaration) : {}),
            waiting: entry?.waiting ?? 0,
            active: entry?.active ?? 0,
            delayed: entry?.delayed ?? 0,
            failed: entry?.failed ?? 0,
            lagMs: entry?.lagMs ?? 0,
            ...(entry?.lastRunAt ? { lastRunAt: entry.lastRunAt.toISOString() } : {}),
            ...(entry?.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt.toISOString() } : {}),
            paused: paused.has(jobId),
          };
        }),
      };
    },
  });

  const runs = defineOperation({
    id: `${prefix}.jobs.runs` as const,
    transport: http.get(`${basePath}/jobs/runs`),
    input: { query: runsQuery },
    output: { 200: runsOutput },
    successStatus: 200,
    errors: [consoleCapabilityUnavailable],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const introspection = requireIntrospection(services.jobs, "jobs.runs");
      const listed = await introspection.listRuns({
        ...(input.query.jobId !== undefined ? { jobId: input.query.jobId } : {}),
        ...(input.query.status !== undefined ? { status: input.query.status } : {}),
        limit: input.query.limit ?? DEFAULT_LIST_LIMIT,
      });
      return { runs: listed.map(runView) };
    },
  });

  const run = defineOperation({
    id: `${prefix}.jobs.run` as const,
    transport: http.get(`${basePath}/jobs/run`),
    input: { query: runQuery },
    output: { 200: runOutput },
    successStatus: 200,
    errors: [consoleCapabilityUnavailable, jobRunNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const introspection = requireIntrospection(services.jobs, "jobs.run");
      const found = await introspection.getRun(input.query.runId);
      if (!found) throw operationFailure(jobRunNotFound);
      return { run: runView(found) };
    },
  });

  const retry = defineOperation({
    id: `${prefix}.jobs.retry` as const,
    transport: http.post(`${basePath}/jobs/retry`),
    input: { body: runIdBody },
    output: { 200: runOutput },
    successStatus: 200,
    errors: [jobRunNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const retried = await services.jobs.retry(input.body.runId);
      if (!retried) throw operationFailure(jobRunNotFound);
      return { run: runView(retried) };
    },
  });

  const discard = defineOperation({
    id: `${prefix}.jobs.discard` as const,
    transport: http.post(`${basePath}/jobs/discard`),
    input: { body: discardBody },
    output: { 200: runOutput },
    successStatus: 200,
    errors: [jobRunNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const discarded = await services.jobs.discard(input.body.runId, input.body.reason);
      if (!discarded) throw operationFailure(jobRunNotFound);
      return { run: runView(discarded) };
    },
  });

  const retryAll = defineOperation({
    id: `${prefix}.jobs.retry-all` as const,
    transport: http.post(`${basePath}/jobs/retry-all`),
    input: { body: retryAllBody },
    output: { 200: retryAllOutput },
    successStatus: 200,
    errors: [],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services, context }) => {
      const limit = input.body.limit ?? DEFAULT_LIST_LIMIT;
      const failed = await services.jobs.listFailed({ limit: limit * 4 });
      const runIds: string[] = [];
      for (const item of failed) {
        if (context.signal?.aborted || runIds.length >= limit) break;
        if (input.body.jobId !== undefined && item.jobId !== input.body.jobId) continue;
        const retried = await services.jobs.retry(item.runId);
        if (retried) runIds.push(retried.runId);
      }
      return { retried: runIds.length, runIds };
    },
  });

  const pause = defineOperation({
    id: `${prefix}.jobs.pause` as const,
    transport: http.post(`${basePath}/jobs/pause`),
    input: { body: jobIdBody },
    output: { 200: pausedOutput },
    successStatus: 200,
    errors: [consoleCapabilityUnavailable, consoleJobNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const introspection = requireIntrospection(services.jobs, "jobs.pause");
      if (!introspection.pause) {
        throw operationFailure(consoleCapabilityUnavailable, {
          details: { capability: "jobs.pause", adapter: services.jobs.adapter },
        });
      }
      assertDeclared(introspection, input.body.jobId);
      await introspection.pause(input.body.jobId);
      return { jobId: input.body.jobId, paused: true };
    },
  });

  const resume = defineOperation({
    id: `${prefix}.jobs.resume` as const,
    transport: http.post(`${basePath}/jobs/resume`),
    input: { body: jobIdBody },
    output: { 200: pausedOutput },
    successStatus: 200,
    errors: [consoleCapabilityUnavailable, consoleJobNotFound],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const introspection = requireIntrospection(services.jobs, "jobs.resume");
      if (!introspection.resume) {
        throw operationFailure(consoleCapabilityUnavailable, {
          details: { capability: "jobs.resume", adapter: services.jobs.adapter },
        });
      }
      assertDeclared(introspection, input.body.jobId);
      await introspection.resume(input.body.jobId);
      return { jobId: input.body.jobId, paused: false };
    },
  });

  return Object.freeze({
    overview,
    runs,
    run,
    retry,
    discard,
    retryAll,
    pause,
    resume,
    operations: Object.freeze([
      overview,
      runs,
      run,
      retry,
      discard,
      retryAll,
      pause,
      resume,
    ] as const),
  });
}

export type ConsoleJobOperations<TPrefix extends string = string> = ReturnType<
  typeof defineConsoleJobOperations<TPrefix>
>;

function assertDeclared(introspection: JobIntrospection, jobId: string): void {
  if (!introspection.declarations().some((item) => item.id === jobId)) {
    throw operationFailure(consoleJobNotFound);
  }
}
