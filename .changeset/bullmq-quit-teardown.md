---
"@sixthsummit/ship-jobs-bullmq": patch
---

Make `quit()` on the BullMQ job backend idempotent and leave no Redis traffic behind: the OpenTelemetry queue observer is unregistered before workers and queues close (`JobMetrics.observeQueues` now returns the unregister function), a metrics collection or health probe that lands after `quit()` no longer recreates a closed queue and opens a fresh connection, and `startWorkers` refuses to run after `quit()`. This removes the unhandled ioredis "Connection is closed" rejections seen when a backend was quit while bookkeeping was still in flight.
