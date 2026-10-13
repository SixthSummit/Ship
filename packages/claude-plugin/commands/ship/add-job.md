---
description: Scaffold a BullMQ job stub in an existing module via `ship-api g job <name> -m <module>`. Drops a typed payloadSchema + processor at `modules/<module>/jobs/<name>.job.ts` ready to be auto-discovered by the `InitJobs` bootstrapper.
argument-hint: <job-name> -m <module>
allowed-tools: Bash, Read
---

Scaffold a BullMQ job stub via the framework CLI:

```sh
ship-api g job $1 $2
```

The generator creates `modules/<module>/jobs/<job-name>.job.ts` with:

- A typed Zod payload schema (`<jobName>PayloadSchema`)
- An inferred TypeScript payload type
- A processor stub with the right signature
- Default-export shape that `InitJobs` auto-discovers at boot under the module's queue

After generation:

1. Read the new file and replace the TODO payload schema with the real fields the job carries.
2. Implement the processor body (the consumer's domain logic).
3. Compose any new env vars into `src/environment.ts` if the job depends on them (e.g. an external API key).
4. Run `npm run type-check && npm run lint && npm test` to verify.

Producer-side: route handlers enqueue via the framework's `enqueue("queueName", "<job-name>", payload)` API. NEVER enqueue inside a DB transaction — use the outbox pattern (`OutboxEventEmitter.emit({...}, { tx })`) when atomic-with-domain-write is needed; the registered EventHandler does the BullMQ enqueue when the outbox drains.

Reference the canonical example at `modules/outbox/` for the full outbox-event-handler-bullmq composition pattern.
