---
"@sixthsummit/ship-core": minor
---

Add optional operator introspection to the adapter contracts for the ops console (SAPI-757): `JobBackend.introspection` (`declarations`, `listRuns`, `getRun`, `listSchedules`, `listPaused`, optional `pause`/`resume`, with `isJobIntrospection` and `jobIntrospection`), `WebhookEventStore.list`, `OutboxBackend.findRecord`/`listRecords`, and `RealtimePublishBackend.introspection.channels` (`isRealtimeIntrospection`). Every member is optional, so existing adapters keep compiling.
