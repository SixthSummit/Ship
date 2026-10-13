import { defineApp, defineJob, defineModule } from "@sixthsummit/ship-core";
import { z } from "zod";

// A schedule without a time zone is rejected at declaration time.
const job = defineJob({
  id: "reports.digest",
  input: z.object({}),
  trigger: { kind: "schedule", cron: "0 6 * * *" } as never,
  concurrency: { mode: "parallel" },
  retry: { attempts: 1, backoff: { initialMs: 10 } },
  transaction: "none",
  dependencies: {},
  handler: async () => undefined,
});

export const app = defineApp({
  id: "invalid-job-fixture",
  modules: [
    defineModule({ id: "reports", operations: [job], providers: [], imports: [], exports: [] }),
  ],
});
