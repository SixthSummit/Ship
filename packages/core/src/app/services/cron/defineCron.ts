import {
  defineJob,
  type JobDefinition,
  type JobHandler,
  type JobRegistry,
  jobRegistry,
} from "../jobs/defineJob.js";

/**
 * `defineCron({ name, schedule, handler, options? })` — schema-driven
 * cron registration via BullMQ repeatable jobs.
 *
 * Cron jobs ARE jobs — they live in the same `jobRegistry` and run on the
 * same Worker as queued jobs. The differences are ergonomic:
 *
 *   - One queue per process by default (`"cron"`), so the framework's
 *     worker picks them up automatically without having to declare a
 *     queue per cron task.
 *   - The handler doesn't receive a meaningful payload — just the
 *     run-context (job id, request context). Payload type is `void`.
 *   - The schedule is expressed at the top level, not nested under
 *     `options.schedule`.
 *
 * Files at `modules/<name>/cron/<cronName>.cron.ts` default-export a
 * `defineCron(...)` call (convention enforced by `ship-api g cron`).
 *
 * @example
 * import { defineCron } from "@sixthsummit/ship-api/app/services/cron";
 *
 * export default defineCron({
 *   name: "purge-stale-tokens",
 *   schedule: "0 2 * * *", // daily at 02:00 UTC
 *   handler: async (_payload, { job }) => {
 *     await refreshTokenService.purgeRevoked();
 *     job.log("done");
 *   },
 * });
 */

export interface DefineCronArgs {
  /** Unique name within the cron queue. */
  name: string;
  /** Cron expression (BullMQ `repeat.pattern`). */
  schedule: string;
  /** Job handler — payload arg is `void` because cron jobs don't carry one. */
  handler: JobHandler<void, unknown>;
  /**
   * Override the queue name. Default `"cron"` so a single Worker handles
   * every cron task in the process. Set when you want a dedicated queue
   * (e.g., low-priority cleanup vs high-priority billing).
   */
  queue?: string;
  /** Optional timezone for the cron pattern (defaults to UTC). */
  tz?: string;
  /** BullMQ JobsOptions applied to each scheduled run. */
  defaultJobOptions?: JobDefinition["options"] extends infer O
    ? O extends { defaultJobOptions?: infer J }
      ? J
      : undefined
    : undefined;
}

/** Default queue name for cron tasks. */
export const CRON_QUEUE = "cron";

export function defineCron(
  args: DefineCronArgs,
  register: { add: (def: JobDefinition) => void } | false = jobRegistry,
): JobDefinition<void, unknown> {
  return defineJob<void, unknown>(
    {
      queue: args.queue ?? CRON_QUEUE,
      name: args.name,
      handler: args.handler,
      options: {
        schedule: { cron: args.schedule, tz: args.tz },
        defaultJobOptions: args.defaultJobOptions,
      },
    },
    register as JobRegistry | false,
  );
}
