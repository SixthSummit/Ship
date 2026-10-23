---
"@sixthsummit/ship-testing": minor
"@sixthsummit/ship-jobs-bullmq": minor
"@sixthsummit/ship-drizzle": minor
"@sixthsummit/ship-realtime-socketio": minor
---

Implement the kernel's operator introspection for the ops console (SAPI-757): the in-memory job, webhook-event, outbox and realtime backends; the BullMQ backend (`getJobs`, job scheduler `next`, `queue.pause`/`resume`); the PostgreSQL job backend (run and schedule queries, durable pause through the new opt-in `shipJobControlTable()` passed as `controlTable`, read once per worker poll), outbox (`findRecord`/`listRecords`) and webhook event store (`list`); and the Socket.IO gateway (per-channel subscriber and scope counts, last publish).
