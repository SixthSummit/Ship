/** Type-level CI contract for webhook declarations, handlers and intents. */
import { z } from "zod";
import { effectDependency, unitOfWorkDependency } from "./dependency.js";
import { idempotencyStoreDependency } from "./idempotency.js";
import { defineOutbox } from "./outbox.js";
import {
  type AnyWebhook,
  defineWebhook,
  defineWebhookCleanup,
  defineWebhookReplay,
  defineWebhookVerifier,
  type WebhookResponseDeclaration,
  webhookEventStoreDependency,
  webhookIntent,
  webhookSecret,
  webhookVerifierToken,
} from "./webhook.js";

const verifier = defineWebhookVerifier({
  id: "fixture",
  guarantees: { signature: true, freshness: false, replay: false },
  verify: () => ({ ok: true }),
});
const provider = webhookVerifierToken({ verifier, secret: webhookSecret("s") });
const store = idempotencyStoreDependency("platform.idempotency");
const events = webhookEventStoreDependency("platform.webhook-events");
const unitOfWork = unitOfWorkDependency<{ readonly records: { save(): void } }>("database.primary");
const notifier = effectDependency<{ send(id: string): Promise<void> }>("ingress.notifier", {
  delivery: "immediate",
});

const inline = defineWebhook({
  id: "ingress.fixture-webhook",
  path: "/webhooks/fixture",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  transaction: "none",
  dependencies: { notifier },
  effects: [notifier],
  handler: async ({ event, services, context }) => {
    event.rawBody satisfies Uint8Array;
    event.headers satisfies Readonly<Record<string, string>>;
    event.verified.bodyDigest satisfies string;
    // The actor is narrowed to a provider actor by providerAccess().
    context.actor.provider satisfies string;
    await services.notifier.send(event.verified.eventId ?? "digest");
    return { ok: true as const };
  },
});
inline.id satisfies "ingress.fixture-webhook";
inline.mode satisfies "inline";
inline.operation.transport?.binding satisfies "POST /webhooks/fixture" | undefined;
inline.operation.access.provider satisfies string;

defineWebhook({
  id: "ingress.bad-webhook",
  path: "/webhooks/bad",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  transaction: "none",
  dependencies: {},
  // @ts-expect-error the handler result must match the declared success schema
  handler: () => ({ ok: false }),
});

const outbox = defineOutbox({
  id: "ingress.outbox",
  intents: {
    process: webhookIntent({
      effect: notifier,
      perform: ({ effect, event }) => effect.send(event.eventId),
    }),
  },
});

const enqueue = defineWebhook({
  id: "ingress.durable-webhook",
  path: "/webhooks/durable",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "wait", maxMs: 100 } },
  retention: { eventsMs: 1, claimsMs: 1 },
  receive: { mode: "enqueue", outbox, intent: "process", store: events, unitOfWork },
});
enqueue.mode satisfies "enqueue";
enqueue.operation.transaction satisfies "write";
enqueue.operation.successStatus satisfies 202;
// Precisely typed webhooks flow into the generic replay and cleanup helpers.
enqueue satisfies AnyWebhook;
inline satisfies AnyWebhook;
const replay = defineWebhookReplay({
  id: "ingress.replay",
  webhooks: [enqueue],
  unitOfWork,
  store: events,
});
const cleanup = defineWebhookCleanup({
  id: "ingress.cleanup",
  webhooks: [enqueue, inline],
  store: events,
});
// Generated operations keep literal ids so application maps stay precisely keyed.
replay.id satisfies "ingress.replay";
cleanup.id satisfies "ingress.cleanup";

defineWebhook({
  id: "ingress.durable-webhook",
  path: "/webhooks/durable",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "wait", maxMs: 100 } },
  retention: { eventsMs: 1, claimsMs: 1 },
  // @ts-expect-error the intent must be declared by the outbox
  receive: { mode: "enqueue", outbox, intent: "missing", store: events, unitOfWork },
});

webhookIntent({
  effect: notifier,
  // @ts-expect-error the event reference has no body; load it from the event store
  perform: ({ event }) => event.body,
});

// Response modes: text/binary/empty handlers return the body itself (or respond()).
const voice = defineWebhook({
  id: "ingress.voice-webhook",
  path: "/webhooks/voice",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/x-www-form-urlencoded"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  response: { mode: "text", contentType: "text/xml" },
  transaction: "none",
  dependencies: {},
  handler: () => "<Response/>",
});
voice.response satisfies WebhookResponseDeclaration;
voice.operation.successStatus satisfies 200;
voice.operation.transport?.metadata.response satisfies
  | "json"
  | "text"
  | "binary"
  | "empty"
  | undefined;
voice satisfies AnyWebhook;

defineWebhook({
  id: "ingress.voice-webhook",
  path: "/webhooks/voice",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  response: { mode: "text", contentType: "text/xml" },
  transaction: "none",
  dependencies: {},
  // @ts-expect-error a text webhook returns a string, not an object
  handler: () => ({ twiml: "<Response/>" }),
});

const textWithoutContentType = {
  id: "ingress.voice-webhook",
  path: "/webhooks/voice",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  response: { mode: "text" },
  transaction: "none",
  dependencies: {},
  handler: () => "<Response/>",
} as const;
// @ts-expect-error text mode requires a contentType
defineWebhook(textWithoutContentType);

const status = defineWebhook({
  id: "ingress.status-webhook",
  path: "/webhooks/status",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  response: { mode: "empty" },
  successStatus: 204,
  transaction: "none",
  dependencies: {},
  handler: () => {},
});
status.operation.successStatus satisfies 204;

const download = defineWebhook({
  id: "ingress.download-webhook",
  path: "/webhooks/download",
  provider,
  body: { maxBytes: 1024, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 1, store, inFlight: { kind: "retry", status: 409 } },
  response: { mode: "binary", contentType: "application/pdf" },
  transaction: "none",
  dependencies: {},
  handler: () => new Uint8Array(0),
});
download.response.mode satisfies "json" | "text" | "binary" | "empty";

// Replay transports: the :eventId parameter or the JSON body carries the event id.
const replayByParams = defineWebhookReplay({
  id: "ingress.replay-by-params",
  webhooks: [enqueue],
  unitOfWork,
  store: events,
  transport: { path: "/webhooks/:eventId/replay" },
});
replayByParams.input satisfies { readonly params: unknown };
replayByParams.transport?.binding satisfies "POST /webhooks/:eventId/replay" | undefined;
const replayByBody = defineWebhookReplay({
  id: "ingress.replay-by-body",
  webhooks: [enqueue],
  unitOfWork,
  store: events,
  transport: { path: "/webhooks/replay" },
});
replayByBody.input satisfies { readonly body: unknown };
// Any single :name segment carries the event id, so a legacy route keeps its id in the URL.
const replayLegacy = defineWebhookReplay({
  id: "ingress.replay-legacy",
  webhooks: [enqueue],
  unitOfWork,
  store: events,
  transport: { path: "/webhooks/:id/retry", eventIdParameter: "id" },
});
replayLegacy.input satisfies { readonly params: unknown };
type LegacyParams = (typeof replayLegacy)["input"]["params"]["~standard"]["types"];
({ id: "evt" }) satisfies NonNullable<LegacyParams>["output"];
// @ts-expect-error the parameter is named by the path, not eventId
({ eventId: "evt" }) satisfies NonNullable<LegacyParams>["output"];
replay.transport satisfies undefined;
replay.input satisfies { readonly body: unknown };
