/** Type-level CI contract for outbox declarations, writers and dispatchers. */
import { z } from "zod";
import { publicAccess } from "./access.js";
import { effectDependency, unitOfWorkDependency } from "./dependency.js";
import { defineOperation } from "./operation.js";
import {
  defineOutbox,
  defineOutboxCleanup,
  defineOutboxDispatcher,
  type OutboxBackend,
  outboxDependency,
  outboxIntent,
} from "./outbox.js";
import { valueProvider } from "./provider.js";

interface Notifier {
  send(message: { readonly recipient: string }): Promise<void>;
}
const notifier = effectDependency<Notifier>("reports.notifier", { delivery: "immediate" });
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(): void } }>("database.primary");

const outbox = defineOutbox({
  id: "reports.outbox",
  retention: { completedMs: 1, deadLetteredMs: 1 },
  intents: {
    notify: outboxIntent({
      payload: z.object({ recipient: z.string().email() }),
      effect: notifier,
      // The effect provider and payload are typed from the intent declaration.
      perform: ({ effect, payload }) => effect.send({ recipient: payload.recipient }),
    }),
  },
});
outbox.id satisfies "reports.outbox";

outboxIntent({
  payload: z.object({ recipient: z.string() }),
  effect: notifier,
  // @ts-expect-error the payload type follows the declared schema
  perform: ({ payload }) => payload.missing,
});

defineOperation({
  id: "reports.request",
  input: { body: z.object({ recipient: z.string().email() }) },
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "write",
  dependencies: { tx: unitOfWork, outbox: outboxDependency(outbox) },
  handler: async ({ input, services }) => {
    services.outbox.enqueue("notify", { recipient: input.body.recipient }, { dedupeKey: "k" });
    // @ts-expect-error only declared intents can be enqueued
    services.outbox.enqueue("missing", {});
    // @ts-expect-error payloads follow the intent schema input type
    services.outbox.enqueue("notify", { recipient: 1 });
    return { ok: true as const };
  },
});

const dispatcher = defineOutboxDispatcher(outbox, {
  batchSize: 10,
  lease: { ms: 1_000 },
  retry: { attempts: 3, backoff: { initialMs: 100 } },
  deadLetter: true,
  intents: ["notify"],
});
dispatcher.dispatch.id satisfies string;

defineOutboxDispatcher(outbox, {
  batchSize: 10,
  lease: { ms: 1_000 },
  retry: { attempts: 3, backoff: { initialMs: 100 } },
  // @ts-expect-error dead-lettering cannot be disabled
  deadLetter: false,
});

defineOutboxDispatcher(outbox, {
  batchSize: 10,
  lease: { ms: 1_000 },
  retry: { attempts: 3, backoff: { initialMs: 100 } },
  deadLetter: true,
  // @ts-expect-error dispatcher intent subsets must name declared intents
  intents: ["missing"],
});

// The backend provider binds to the writer token with the OutboxBackend value type.
declare const backend: OutboxBackend;
valueProvider(outbox.writer, backend);

defineOutboxCleanup(outbox);
