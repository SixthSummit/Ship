---
"@sixthsummit/ship-console": minor
---

Initial release of the operator console module (SAPI-757). `defineConsoleModule({ imports, jobs, outboxes, webhooks, realtime, extensions })` composes jobs (depth, running, failed, dead-letter, run detail, retry, discard, bulk retry, pause/resume), cron (schedules with next and last run, trigger-now), webhooks (receipts by endpoint with the spawned outbox record, recent outcomes via `createConsoleWebhookObserver`, detail, replay), realtime (channels with subscriber counts and last publish) and outbox (pending/leased/dead-lettered inspection, retry, discard) as declared operations under `/console/*`, every one gated by the dedicated `console.operate` permission that no management slug or admin role implies, plus an extension seam for further panels.
