---
description: Scaffold a new `defineCron({ name, schedule, handler })` file in an existing module at `modules/<module>/cron/<cron-name>.cron.ts`. Cron files are auto-discovered by `InitCron` and registered as BullMQ repeatable jobs (single source for queue + cron — no separate scheduler).
argument-hint: <cron-name> -m <module>
allowed-tools: Bash, Read, Write
---

Scaffold a `defineCron` declaration file at the conventional path
`modules/<module>/cron/$1.cron.ts`. Use this template (replace `<module>` and the schedule placeholder):

```ts
import { defineCron } from "@sixthsummit/ship-api";
import { logger } from "@sixthsummit/ship-api/observability/logger";

export default defineCron({
  name: "<module>.$1",
  // Cron expression — minute-hour-day-month-dow. See https://crontab.guru.
  // Example: "*/5 * * * *" runs every 5 minutes.
  schedule: "TODO replace with cron expression",
  handler: async () => {
    logger.info({ cron: "<module>.$1" }, "running");
    // Domain logic here. Throw to mark the run failed (BullMQ records
    // the error; the next run still fires on schedule).
  },
});
```

Then:

1. Replace the `schedule` placeholder with a real cron expression. Validate at https://crontab.guru.
2. Implement the handler body with the domain logic.
3. The file is **auto-discovered** at boot by `InitCron` walking `modules/*/cron/*.cron.ts` — no manual registration. The cron only fires when the process is in worker role (`WORKER_MODE=worker` or `all`).
4. Each run gets:
   - An OTel span named `cron.<name>` (the `name:` field from the definition above).
   - A child `logger` binding with `{ cron: <name>, jobId, attemptsMade }`.
   - A Prometheus counter increment `cron_runs_total{name,result}`.
5. Verify locally: set `WORKER_MODE=all` in your `.env`, run `ship-api dev`, watch logs for the first scheduled run. For testing without waiting, use `BullMQ`'s admin UI or trigger manually via the queue API.

`defineCron` runs cron through BullMQ's repeatable-job mechanism, so:

- Cron state survives process restarts (no missed runs across deploys, modulo the in-flight-window).
- Multiple worker processes coordinate via Redis — a 5-minute cron fires exactly once across the cluster, not once per worker.
- Cron history shows up in Bull-Board (when enabled in `v4.x`).

Conventions:

- One cron per file; the file name (kebab-case) should match the `name:` suffix.
- Names are dot-namespaced — `<module>.<cron-name>` — so cron names stay unique across modules.
- Don't put long-running work directly in the handler. If the work takes more than a few seconds, enqueue a regular BullMQ job (`enqueue("<queue>", "<job>", payload)`) and let the cron act as a scheduler that fans out actual work into the job queue.
