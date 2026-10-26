# @sixthsummit/ship-console

## 0.2.0

### Minor Changes

- 5e2858d: Initial release of the operator console module (SAPI-757). `defineConsoleModule({ imports, jobs, outboxes, webhooks, realtime, extensions })` composes jobs (depth, running, failed, dead-letter, run detail, retry, discard, bulk retry, pause/resume), cron (schedules with next and last run, trigger-now), webhooks (receipts by endpoint with the spawned outbox record, recent outcomes via `createConsoleWebhookObserver`, detail, replay), realtime (channels with subscriber counts and last publish) and outbox (pending/leased/dead-lettered inspection, retry, discard) as declared operations under `/console/*`, every one gated by the dedicated `console.operate` permission that no management slug or admin role implies, plus an extension seam for further panels.

### Patch Changes

- 63eef39: Require `zod` `^4.6.7` (GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections) and resolve `body-parser` to `2.4.0` under the MCP server's Express dependency (GHSA-27r3-jxmh-p828). No API change; the Angular library now runs its own suite against zod 4 and the Angular scaffold template asks for `zod ^4.6.7`.
