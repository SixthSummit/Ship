# Combined capacity baseline (M10, SAPI-113 step 11)

The capacity baseline is a framework-owned, re-runnable harness that puts every
M10 kernel capability under load at once, on one machine, against one
disposable PostgreSQL and one disposable Redis. It exists to give the program a
number to compare against after a change, and to name the first thing that
gives way at a stated load shape. It is not a production capacity claim.

Harness: `fixtures/capacity/` (runner `scripts/test-capacity.mjs`). Results are
written under the gitignored `.capacity/` directory as a Markdown table and a
JSON summary; the latest run of any label is also copied to `latest.md` and
`latest.json`.

## How to run

```sh
pnpm test:capacity          # 600 s measured load (CAPACITY_DURATION_SECONDS=600)
pnpm test:capacity:short    # 60 s smoke shape for CI (CAPACITY_MODE=short)
```

Docker must be available: the harness starts `postgres:16-alpine` (through
`@sixthsummit/ship-testing/postgres`, which pushes the consumer schema) and
`redis:7-alpine` with testcontainers. The runner packs every Ship package the
harness or the consumer imports, installs the tarballs into a copy outside the
workspace with recorded provenance (`.ship/framework-provenance.json`), copies
the customized golden consumer's application source next to the harness, runs
the harness's Biome and TypeScript gates, and only then starts the load. No
workspace link, patched package or skipped test is involved; the harness fails
if any Ship package resolves to the workspace.

`--keep` leaves the run directory in place and `--reuse <dir>` re-copies the
sources into it without packing or installing again, which is how a knob can be
moved and re-measured in about a minute.

### Knobs

Every knob is an environment variable read once at start and recorded in the
summary. `CAPACITY_DURATION_SECONDS` wins over the mode default.

| Knob | Default | Meaning |
| --- | ---: | --- |
| `CAPACITY_MODE` | `full` | `short` switches the duration default to 60 s |
| `CAPACITY_DURATION_SECONDS` | 600 (60 in short mode) | Measured load window |
| `CAPACITY_WARMUP_SECONDS` | 10 | Every lane runs at full rate first; counters reset before measurement |
| `CAPACITY_SAMPLE_INTERVAL_SECONDS` | 10 | Fixed sampling interval |
| `CAPACITY_TENANTS` | 6 | Tenant keys the jobs lane spreads over (minimum 3) |
| `CAPACITY_JOB_ENQUEUE_PER_SECOND` | 500 | `reports.deliver` enqueues per second, round-robin across tenants |
| `CAPACITY_WORKER_PROCESSES` | 2 | Worker processes running the declared jobs and the outbox dispatchers |
| `CAPACITY_WORKER_MAX_IN_FLIGHT` | 8 | Process-wide in-flight budget of each worker's BullMQ backend |
| `CAPACITY_DISPATCH_INTERVAL_MS` | 250 | Idle interval of each worker's four dispatcher runners (`startOutboxDispatchRunner`): a full batch is followed by the next pass at once, a short or empty batch waits this long |
| `CAPACITY_DISPATCH_PASSES_PER_CYCLE` | 10 | Full passes a dispatcher runner takes back to back before yielding to the interval |
| `CAPACITY_DB_POOL_SIZE` | 8 | `pg.Pool` size in the API process and in each worker |
| `CAPACITY_REALTIME_RATE_PER_SECOND` | 500 | ADR-0017 publish rate |
| `CAPACITY_REALTIME_LATE_MS` | 250 | End-to-end latency above which a delivered message counts as late |
| `CAPACITY_WEBHOOK_BURST_SIZE` | 100 | Signed events per burst |
| `CAPACITY_WEBHOOK_BURST_INTERVAL_SECONDS` | 10 | Time between burst starts |
| `CAPACITY_WEBHOOK_CONCURRENCY` | 25 | In-flight requests inside a burst |
| `CAPACITY_DRAIN_SECONDS` | 60 | Wait after the load window for queues, outboxes and subscribers to drain |
| `CAPACITY_OUTPUT_DIR` | `.capacity` | Where the Markdown and JSON land |
| `CAPACITY_LABEL` | mode name | File name suffix for the run |

## What runs

One API process (the harness itself) composes the customized golden consumer
with the production adapters: PostgreSQL through `@sixthsummit/ship-drizzle`
for the unit of work, all four outboxes, the idempotency store and the webhook
event store; `@sixthsummit/ship-jobs-bullmq` on Redis for jobs and the Redis
lock provider; `@sixthsummit/ship-cache-redis`; and the Socket.IO Redis
publisher from `@sixthsummit/ship-realtime-socketio`. Two gateway processes
run `createRealtimeGateway` with the consumer's own session credential adapter
and actor resolver. N worker processes compose the same application in
`worker` mode and additionally drive `reports.outbox.dispatch`,
`payments.outbox.dispatch`, `ship-cache.invalidation.dispatch` and
`ship-realtime.publication.dispatch`, one `startOutboxDispatchRunner` each,
at the dispatch interval (since SAPI-114; the baseline below ran a
fixed-interval loop).

Three lanes run concurrently for the whole window:

- **Jobs.** `reports.deliver` (keyed single-runner, declared `max: 4`, retry
  backoff 1 s) is enqueued through the BullMQ backend at the configured rate,
  round-robin across the tenant keys, with a distinct `(tenant, period)` per
  run so every outbox intent is distinct. Each run re-authorizes the tenant as
  a system actor, inserts a request row and records an outbox intent in one
  transaction.
- **Realtime.** The actor-scoped `reports.delivered` channel is published at
  the ADR-0017 rate through the kernel channel publisher bound to the Redis
  publisher, exactly as an operation handler would. One subscriber per gateway
  counts received messages, end-to-end latency (publisher clock to client
  receipt), late messages and gateway drop reports; missing = published minus
  received.
- **Webhooks.** Every burst interval, a burst of Stripe-signed events hits
  `payments.stripe-webhook` (enqueue mode: raw bytes and the outbox intent
  commit together before the 202) through the Hono adapter. One in twenty is
  tampered after signing and must be rejected with 401.

## What it measures

Every sample records, per lane and for the shared infrastructure:

- jobs: waiting, delayed (contention retries), active and failed counts from
  the backend health; oldest-waiting age; enqueue-to-start lag and handler
  duration sampled from the 300 most recent completions (BullMQ timestamps);
  rows committed in the window per tenant key with min/median/max (fairness);
  enqueues, `queue-full` rejections and enqueue call latency;
- PostgreSQL: client backends, active, idle-in-transaction and lock-waiting
  backends from `pg_stat_activity`; `pg_locks` rows not granted;
- Redis: `used_memory`, `used_memory_peak`, connected clients (`INFO`);
- outbox: rows per outbox and status, and the total pending backlog;
- realtime: published, publisher drops, per-gateway received, late, dropped
  and latency distribution for the window;
- webhooks: bursts, sent, accepted, rejected, unexpected statuses and latency.

The summary adds run-wide distributions, peaks, the worst fairness window, the
outbox backlog at start, peak, end of load and after drain, Redis growth per
minute over the load window, the child processes' own summaries and the gate
result. The harness fails only on correctness: an unexpected webhook status, a
dead-lettered job run, or a process that exited before the run ended. Loss,
lateness and backlog are reported, not asserted.

## What it does not claim

- It is not production capacity. Every process, both containers and the
  Docker VM share one laptop; there is no network between the API, the
  workers, the gateways, PostgreSQL and Redis, and the effect adapters are
  no-ops. Absolute numbers move with the host; the shape (what saturates first,
  and which knob moves it) is the durable result.
- The API process is also the load generator. Enqueue pacing, realtime
  publishing, webhook bursts and sampling share its event loop; above roughly
  900 enqueues per second on the reference host the generator itself becomes
  a limit, which is why the default shape sits at 500/s.
- Lag figures are sampled (the 300 most recent completions per window) so the
  observer does not stall the event loop it shares with the publisher.
- Warm-up rows stay in the database; the t=0 sample records the outbox backlog
  and Redis memory they left behind, and job totals count only rows committed
  after measurement began.
- The consumer's declarations are measured as declared: the digest retention,
  dispatcher batch size (25) and lease, and the job's backoff are the golden
  consumer's, not tuned for load.

## Baseline on dev `86831de` (2026-09-18)

Reference host: Apple M2 Max, 12 CPUs, 96 GB, Docker Desktop VM with 32 GB;
Node 22.22.0; every process, PostgreSQL and Redis on the one machine. Default
knobs (500 jobs/s over 6 tenant keys, 2 workers, 500 realtime/s, 100-event
webhook burst every 10 s, 250 ms dispatch interval). Full outputs:
`.capacity/2026-09-18T23-31-44-115Z-baseline-600s.{md,json}` on the machine
that ran it; the tables below are copied from them.

### Capacity table (600 s)

| Measure | Value |
| --- | --- |
| Run | full, 600 s load after 10 s warm-up, sample every 10 s, dev `86831de` |
| Topology | 1 API process, 2 worker processes (maxInFlight 8, pool 8), 2 gateway processes, 1 PostgreSQL (postgres:16-alpine), 1 Redis (redis:7-alpine) |
| Jobs: offered | 299992 enqueued at 500/s across 6 tenant keys (0 queue-full) |
| Jobs: completed | 299996 rows committed (452.9/s incl. drain); dead-lettered 0; drained yes in 62.4 s |
| Jobs: queue depth | peak waiting 0, peak delayed (contention retries) 5, peak active 4; peak oldest-waiting age 0.0 s |
| Jobs: enqueue-to-start lag (ms) | p50 0 / p95 1 / p99 1 / max 5703; 11 of 18001 sampled runs waited >= 1 s (single-runner contention retry) |
| Jobs: handler duration (ms) | p50 2 / p95 5 / p99 7 / max 43 |
| Jobs: enqueue call (ms) | p50 0.4 / p95 0.8 / p99 1.4 / max 49.2 |
| Jobs: fairness, whole run | min 49999 / median 49999 / max 50000 completions per tenant |
| Jobs: fairness, worst window | min 835 / median 837 / max 841 per tenant per 10 s window (at 2026-09-18T23:21:05.040Z) |
| Realtime: published | 299992 at 500/s (target 500/s); publisher dropped 0; publish() p50 0 / p95 0 / p99 0 / max 9.2 ms |
| Realtime: gateway-a | received 299992, missing 0, late (>250 ms) 0, dropped by gateway 0; end-to-end p50 0 / p95 1 / p99 1 / max 188 ms |
| Realtime: gateway-b | received 299992, missing 0, late (>250 ms) 0, dropped by gateway 0; end-to-end p50 0 / p95 1 / p99 1 / max 188 ms |
| Webhooks | 60 bursts of 100 (concurrency 25); 5700 accepted (202), 300 tampered rejected (401), 0 unexpected |
| Webhooks: latency (ms) | p50 16.2 / p95 24.7 / p99 33.1 / max 51.2; worst burst #2 p95 43.6 / max 51.2 |
| PostgreSQL | peak client backends 22, peak active 7, peak idle-in-transaction 7, peak backends waiting on a lock 0, peak `pg_locks` not granted 1 |
| Redis | peak used_memory 364.4 MiB, peak connected clients 34, used_memory growth 35.5 MiB/min over the load window |
| Outbox backlog | pending at start 3196, peak pending 206467, pending at end of load 203885, after drain 204248 (not drained within 60 s) |
| Outbox (final) | payments.outbox: completed 5795; reports.outbox: claimed 31, completed 100744, pending 204217 |
| Gates | passed |

### Timeline, one row per minute

| t (s) | phase | jobs done/s | delayed | lag p95 (ms) | fairness min/med/max | outbox pending | pg backends | pg lock waits | redis MiB | rt recv A/B | wh p95 (ms) |
| ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |
| 60 | load | 501 | 1 | 1 | 834/835/836 | 22764 | 22 | 0 | 45 | 5012/5012 | 19.4 |
| 120 | load | 501 | 3 | 1 | 834/835.5/836 | 42286 | 20 | 0 | 79 | 5014/5014 | 31.6 |
| 180 | load | 502 | 1 | 1 | 835/836/836 | 62141 | 20 | 0 | 115 | 5015/5015 | 19.3 |
| 241 | load | 502 | 0 | 1 | 836/836/837 | 82189 | 18 | 0 | 149 | 5014/5014 | 18.2 |
| 301 | load | 502 | 0 | 1 | 835/836/837 | 102479 | 19 | 0 | 187 | 5017/5017 | 18 |
| 361 | load | 502 | 0 | 1 | 836/836.5/837 | 123077 | 20 | 0 | 221 | 5016/5016 | 17 |
| 421 | load | 502 | 0 | 1 | 836/837/837 | 143856 | 20 | 0 | 255 | 5016/5016 | 26.3 |
| 481 | load | 502 | 0 | 1 | 836/836.5/837 | 164838 | 19 | 0 | 290 | 5022/5022 | 19.4 |
| 542 | load | 502 | 0 | 1 | 836/836.5/837 | 186084 | 19 | 0 | 330 | 5024/5024 | 19.1 |
| 602 | drain | 403 | 0 | 1 | 671/672/673 | 206467 | 11 | 0 | 364 | 4015/4015 | n/a |
| 612 | drain | 0 | 0 | n/a | 0/0/0 | 205117 | 6 | 0 | 364 | 0/0 | n/a |
| 622 | drain | 0 | 0 | n/a | 0/0/0 | 205017 | 6 | 0 | 364 | 0/0 | n/a |
| 633 | drain | 0 | 0 | n/a | 0/0/0 | 204313 | 7 | 1 | 364 | 0/0 | n/a |
| 648 | drain | 0 | 0 | n/a | 0/0/0 | 204261 | 4 | 0 | 364 | 0/0 | n/a |
| 666 | drain | 0 | 0 | n/a | 0/0/0 | 204248 | 6 | 0 | 364 | 0/0 | n/a |

### First bottleneck: outbox dispatch throughput

The jobs lane kept up with 500/s for the whole ten minutes (enqueue-to-start
lag p95 1 ms, fairness within 1 % per window, 11 of 18,001 sampled starts held
back by a single-runner contention retry), the realtime lane delivered every
one of 299,992 messages to both gateways with zero late (p99 1 ms), the
webhook bursts stayed at p95 25 ms, PostgreSQL never queued a lock, and no
process failed. The first thing that gave way was the **outbox dispatch
throughput**: every `reports.deliver` run commits one `reports.outbox`
intent, so intents arrive at 500/s, while the two workers' dispatchers
completed 100,744 of them in the run, about 150/s. The `reports.outbox`
backlog therefore grew linearly, roughly 20,000 rows per minute, from the
3,196 warm-up rows to a 206,467 peak, and the 60 s drain could not clear it.

The arithmetic is the consumer's declared dispatcher (`DISPATCH_BATCH_SIZE`
25, one claim per round) times the harness's dispatch cadence: each worker
ran about three rounds per second (2,017 rounds in 672 s, with four
dispatchers per round plus the 250 ms pause), so 2 workers x 3 rounds/s x 25
rows = 150 rows/s. The knob that moves it is the dispatch cadence,
`CAPACITY_DISPATCH_INTERVAL_MS` (equivalently, in an application, how often
its worker invokes `<outbox>.dispatch`, or the dispatcher's `batchSize`).

Two related observations, reported rather than diagnosed:

- **Redis grew 35.5 MiB/min (364 MiB peak)** and kept growing in the
  knob-moved run where the outbox backlog stayed near zero, so it is not a
  mirror of the PostgreSQL backlog. It is BullMQ keeping every completed run
  (304,992 at the end, about 1.25 KiB each) because the consumer declares
  `retention.completedMs` of 24 h and `jobs.cleanup` runs once a day; nothing
  the harness does can collect them sooner. At a sustained 500 runs/s that
  retention costs roughly 2 GB of Redis per hour until the sweep. This is a
  retention sizing input, not a leak, and the harness records it so the
  consumer's declared retention can be revisited against real rates.
- During the drain, with about 205,000 pending rows, the backlog shrank at
  only about 16 rows/s against the 150 rows/s the same dispatchers sustained
  under load (and about 240 rows/s in a 30 s probe whose backlog was 12,000).
  The claim query in `@sixthsummit/ship-drizzle` orders due pending and
  lease-expired claimed rows by `available_at` before taking `batchSize`, so
  claim cost appears to grow with the backlog. No `EXPLAIN` was captured; it
  is a follow-up for the outbox adapter, and a reason the backlog should be
  kept small rather than allowed to accumulate.

### Knob moved: dispatch interval 250 ms to 25 ms (60 s confirmation)

`CAPACITY_DISPATCH_INTERVAL_MS=25`, everything else at the defaults, 60 s
short mode (`.capacity/2026-09-18T23-33-36-670Z-knob-dispatch-25ms.{md,json}`):

| Measure | Value |
| --- | --- |
| Run | short, 60 s load after 10 s warm-up, sample every 10 s, dev `86831de` |
| Topology | 1 API process, 2 worker processes (maxInFlight 8, pool 8), 2 gateway processes, 1 PostgreSQL (postgres:16-alpine), 1 Redis (redis:7-alpine) |
| Jobs: offered | 29993 enqueued at 500/s across 6 tenant keys (0 queue-full) |
| Jobs: completed | 29993 rows committed (495.6/s incl. drain); dead-lettered 0; drained yes in 0.5 s |
| Jobs: queue depth | peak waiting 0, peak delayed (contention retries) 0, peak active 3; peak oldest-waiting age 0.0 s |
| Jobs: enqueue-to-start lag (ms) | p50 0 / p95 1 / p99 1 / max 1530; 1 of 1801 sampled runs waited >= 1 s (single-runner contention retry) |
| Jobs: handler duration (ms) | p50 2 / p95 4 / p99 6 / max 8 |
| Jobs: enqueue call (ms) | p50 0.5 / p95 0.7 / p99 1.2 / max 6.6 |
| Jobs: fairness, whole run | min 4998 / median 4999 / max 4999 completions per tenant |
| Jobs: fairness, worst window | min 833 / median 834 / max 834 per tenant per 10 s window (at 2026-09-18T23:32:36.329Z) |
| Realtime: published | 29993 at 500/s (target 500/s); publisher dropped 0; publish() p50 0 / p95 0 / p99 0 / max 0.7 ms |
| Realtime: gateway-a | received 29993, missing 0, late (>250 ms) 0, dropped by gateway 0; end-to-end p50 0 / p95 1 / p99 1 / max 6 ms |
| Realtime: gateway-b | received 29993, missing 0, late (>250 ms) 0, dropped by gateway 0; end-to-end p50 0 / p95 1 / p99 1 / max 6 ms |
| Webhooks | 6 bursts of 100 (concurrency 25); 570 accepted (202), 30 tampered rejected (401), 0 unexpected |
| Webhooks: latency (ms) | p50 18.7 / p95 27.2 / p99 32.7 / max 35.6; worst burst #2 p95 33.1 / max 35.6 |
| PostgreSQL | peak client backends 22, peak active 8, peak idle-in-transaction 8, peak backends waiting on a lock 0, peak `pg_locks` not granted 0 |
| Redis | peak used_memory 45.0 MiB, peak connected clients 34, used_memory growth 34.9 MiB/min over the load window |
| Outbox backlog | pending at start 5, peak pending 71, pending at end of load 36, after drain 0 (drained within 60 s) |
| Outbox (final) | payments.outbox: completed 665; reports.outbox: completed 34993 |
| Gates | passed |

With ten times the dispatch cadence the same two workers complete every
intent as it arrives: pending peaked at 71 rows and reached zero within 0.5 s
of the load window closing, with the jobs, realtime and webhook figures
unchanged. Redis growth stayed at 34.9 MiB/min, which is what separates the
retention observation from the backlog.

## After SAPI-114: adaptive dispatch runner and indexed claim (60 s at defaults)

The two outbox findings above were fixed framework-side
([ADR-0014 addendum](../rearchitecture/decisions/0014-actor-kinds-and-durable-outbox-delivery.md#addendum-2026-09-18-claim-cost-under-a-backlog-and-the-adaptive-dispatch-runner-sapi-114)):
the Drizzle claim runs through two partial indexes instead of sorting every
due row (71 ms to 4.8 ms per 25-row claim at 200k pending), and the workers
drive each dispatcher through `startOutboxDispatchRunner`, which follows a
full batch with the next pass at once and idles only after a short one. The
60 s run at every default (`.capacity/2026-09-19T02-40-50-935Z-short.{md,json}`
on the machine that ran it):

| Measure | Value |
| --- | --- |
| Run | short, 60 s load after 10 s warm-up, sample every 10 s, dev `86a259d` |
| Topology | 1 API process, 2 worker processes (maxInFlight 8, pool 8), 2 gateway processes, 1 PostgreSQL (postgres:16-alpine), 1 Redis (redis:7-alpine) |
| Jobs: offered | 29992 enqueued at 500/s across 6 tenant keys (0 queue-full) |
| Jobs: completed | 29992 rows committed (495.6/s incl. drain); dead-lettered 0; drained yes in 0.5 s |
| Jobs: queue depth | peak waiting 0, peak delayed (contention retries) 0, peak active 4; peak oldest-waiting age 0.0 s |
| Jobs: enqueue-to-start lag (ms) | p50 0 / p95 1 / p99 1 / max 4; 0 of 1800 sampled runs waited >= 1 s (single-runner contention retry) |
| Jobs: handler duration (ms) | p50 2 / p95 5 / p99 8 / max 15 |
| Jobs: enqueue call (ms) | p50 0.4 / p95 0.7 / p99 1.1 / max 8.1 |
| Jobs: fairness, whole run | min 4998 / median 4999 / max 4999 completions per tenant |
| Jobs: fairness, worst window | min 833 / median 834 / max 834 per tenant per 10 s window (at 2026-09-19T02:39:50.619Z) |
| Realtime: published | 29992 at 500/s (target 500/s); publisher dropped 0; publish() p50 0 / p95 0 / p99 0 / max 0.7 ms |
| Realtime: gateway-a | received 29992, missing 0, late (>250 ms) 0, dropped by gateway 0; end-to-end p50 0 / p95 1 / p99 1 / max 7 ms |
| Realtime: gateway-b | received 29992, missing 0, late (>250 ms) 0, dropped by gateway 0; end-to-end p50 0 / p95 1 / p99 1 / max 7 ms |
| Webhooks | 6 bursts of 100 (concurrency 25); 570 accepted (202), 30 tampered rejected (401), 0 unexpected |
| Webhooks: latency (ms) | p50 18.2 / p95 29.3 / p99 33 / max 37.5; worst burst #3 p95 32.9 / max 37.5 |
| PostgreSQL | peak client backends 21, peak active 7, peak idle-in-transaction 8, peak backends waiting on a lock 0, peak `pg_locks` not granted 0 |
| Redis | peak used_memory 45.0 MiB, peak connected clients 34, used_memory growth 34.9 MiB/min over the load window |
| Outbox backlog | pending at start 60, peak pending 139, pending at end of load 108, after drain 0 (drained within 60 s) |
| Outbox (final) | payments.outbox: completed 665; reports.outbox: completed 34992 |
| Gates | passed |

| t (s) | phase | enq/s | done/s | waiting/delayed/active | oldest wait (s) | lag p50/p95 (ms) | contended | fairness min/med/max | outbox pending | pg backends | pg lock waits | redis MiB | rt pub/s | rt recv A/B | rt late A/B | wh sent | wh p95 (ms) |
| ---: | --- | ---: | ---: | --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| 0 | load | 0.0 | 5000.0 | 0/0/0 | 0.0 | n/a | 0 | 833/833/834 | 60 | 21 | 0 | 9.2 | 0.0 | 0/0 | 0/0 | 0 | n/a |
| 10 | load | 500.9 | 500.3 | 0/0/0 | 0.0 | 0/1 | 0 | 833/834/834 | 42 | 20 | 0 | 15.3 | 501.1 | 5010/5010 | 0/0 | 109 | 22.9 |
| 20 | load | 502.5 | 500.9 | 0/0/3 | 0.0 | 0/1 | 0 | 834/835/835 | 80 | 20 | 0 | 21.0 | 502.6 | 5027/5027 | 0/0 | 153 | 32.9 |
| 30 | load | 501.2 | 502.7 | 0/0/4 | 0.0 | 0/1 | 0 | 837/838/838 | 139 | 20 | 0 | 27.0 | 501.0 | 5010/5010 | 0/0 | 138 | 28.2 |
| 40 | load | 501.0 | 501.0 | 0/0/1 | 0.0 | 0/1 | 0 | 835/835/835 | 136 | 21 | 0 | 32.7 | 500.9 | 5009/5009 | 0/0 | 100 | 20.5 |
| 50 | load | 501.2 | 501.4 | 0/0/1 | 0.0 | 0/1 | 0 | 835/836/836 | 108 | 20 | 0 | 38.5 | 501.2 | 5012/5012 | 0/0 | 100 | 22 |
| 60 | drain | 492.4 | 492.9 | 0/0/0 | 0.0 | 0/1 | 0 | 821/821.5/822 | 0 | 13 | 0 | 45.0 | 492.4 | 4924/4924 | 0/0 | 0 | n/a |
| 70 | drain | 0.0 | 0.0 | 0/0/0 | 0.0 | n/a | 0 | 0/0/0 | 0 | 8 | 0 | 44.8 | 0.0 | 0/0 | 0/0 | 0 | n/a |

Pending peaked at 139 rows and drained to zero within the drain window with
the jobs, realtime and webhook figures unchanged from the baseline; each
worker's `reports.outbox.dispatch` runner took 855 rounds in the run, about
14 rounds/s, against the baseline loop's 3 rounds/s. The 250 ms knob no
longer needs moving to keep up with 500/s; it is the idle interval when
nothing is due.
