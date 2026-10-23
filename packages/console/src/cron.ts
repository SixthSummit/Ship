import { defineOperation, jobBackendDependency, operationFailure } from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import {
  consoleCapabilityUnavailable,
  consoleQueueFull,
  consoleScheduleNotFound,
} from "./errors.js";
import type { ConsolePanelOptions } from "./jobs.js";
import { requireIntrospection } from "./jobs.js";
import { consoleAccess } from "./permission.js";
import { scheduleViewSchema, triggerView } from "./views.js";

const schedulesOutput = z.object({ schedules: z.array(scheduleViewSchema) });
const triggerBody = z.object({ jobId: z.string().min(1) });
const triggerOutput = z.object({
  jobId: z.string(),
  runId: z.string(),
  deduplicated: z.boolean(),
});

/**
 * The cron panel: every declared schedule or interval job with its next
 * occurrence (as the backend reconciled it), the last run and success marks,
 * and a trigger-now that enqueues one run with the empty payload a scheduler
 * tick would carry.
 */
export function defineConsoleCronOperations<const TPrefix extends string = string>(
  options: ConsolePanelOptions<TPrefix>,
) {
  const { prefix, basePath, clock } = options;
  const backend = jobBackendDependency();

  const schedules = defineOperation({
    id: `${prefix}.cron.schedules` as const,
    transport: http.get(`${basePath}/cron`),
    input: {},
    output: { 200: schedulesOutput },
    successStatus: 200,
    errors: [consoleCapabilityUnavailable],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ services }) => {
      const introspection = requireIntrospection(services.jobs, "cron.schedules");
      const reconciled = new Map(
        (await introspection.listSchedules()).map((item) => [item.jobId, item]),
      );
      const paused = new Set(await introspection.listPaused());
      const health = await services.jobs.health(clock());
      const scheduled = introspection
        .declarations()
        .filter((item) => item.trigger.kind === "schedule" || item.trigger.kind === "interval")
        .sort((left, right) => left.id.localeCompare(right.id));
      return {
        schedules: scheduled.map((declaration) => {
          const state = reconciled.get(declaration.id);
          const entry = health.jobs.find((item) => item.jobId === declaration.id);
          return {
            jobId: declaration.id,
            trigger: triggerView(declaration.trigger),
            ...(state?.nextAt ? { nextAt: state.nextAt.toISOString() } : {}),
            ...(entry?.lastRunAt ? { lastRunAt: entry.lastRunAt.toISOString() } : {}),
            ...(entry?.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt.toISOString() } : {}),
            paused: paused.has(declaration.id),
            reconciled: state !== undefined,
          };
        }),
      };
    },
  });

  const trigger = defineOperation({
    id: `${prefix}.cron.trigger` as const,
    transport: http.post(`${basePath}/cron/trigger`),
    input: { body: triggerBody },
    output: { 202: triggerOutput },
    successStatus: 202,
    errors: [consoleCapabilityUnavailable, consoleScheduleNotFound, consoleQueueFull],
    access: consoleAccess(),
    transaction: "none",
    dependencies: { jobs: backend },
    handler: async ({ input, services }) => {
      const introspection = requireIntrospection(services.jobs, "cron.trigger");
      const declaration = introspection.declarations().find((item) => item.id === input.body.jobId);
      if (
        !declaration ||
        (declaration.trigger.kind !== "schedule" && declaration.trigger.kind !== "interval")
      ) {
        throw operationFailure(consoleScheduleNotFound);
      }
      const result = await services.jobs.enqueue(declaration.id, {});
      if (!result.accepted) throw operationFailure(consoleQueueFull);
      return { jobId: declaration.id, runId: result.runId, deduplicated: result.deduplicated };
    },
  });

  return Object.freeze({
    schedules,
    trigger,
    operations: Object.freeze([schedules, trigger] as const),
  });
}

export type ConsoleCronOperations<TPrefix extends string = string> = ReturnType<
  typeof defineConsoleCronOperations<TPrefix>
>;
