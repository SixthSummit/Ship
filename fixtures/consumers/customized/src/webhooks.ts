import {
  defineWebhook,
  defineWebhookCleanup,
  defineWebhookReplay,
  idempotencyStoreDependency,
  type UnitOfWorkDependencyToken,
  type WebhookSecretSource,
  webhookEventStoreDependency,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { stripeWebhookVerifier } from "@sixthsummit/ship-webhooks/stripe";
import { twilioWebhookVerifier } from "@sixthsummit/ship-webhooks/twilio";
import { paymentsOutbox } from "./outbox.js";

/** Framework-owned durable raw-event storage, bound to the Drizzle store in production. */
export const webhookEvents = webhookEventStoreDependency("platform.webhook-events");
const idempotencyStore = idempotencyStoreDependency("platform.idempotency");

export interface WebhookSecrets {
  /** Stripe endpoint signing secret(s), newest first. */
  readonly stripe: WebhookSecretSource;
  /** Twilio auth token(s), newest first. */
  readonly twilio: WebhookSecretSource;
}

/** The TwiML an inbound SMS is answered with; Twilio executes it as the reply. */
export const INBOUND_SMS_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thanks, we got it.</Message></Response>';

export function createPaymentWebhooks(
  secrets: WebhookSecrets,
  unitOfWork: UnitOfWorkDependencyToken<unknown>,
  clock?: () => Date,
) {
  // Receive-then-process: the exact Stripe bytes and one outbox intent commit
  // together; the dispatcher performs the ledger effect later, so a slow or
  // failing effect never turns into a Stripe retry storm.
  const stripe = defineWebhook({
    id: "payments.stripe-webhook",
    path: "/webhooks/stripe",
    provider: webhookVerifierToken({
      verifier: stripeWebhookVerifier(),
      secret: secrets.stripe,
    }),
    body: { maxBytes: 262_144, mediaTypes: ["application/json"] },
    idempotency: {
      windowMs: 3 * 24 * 60 * 60 * 1000,
      store: idempotencyStore,
      inFlight: { kind: "retry", status: 409 },
    },
    retention: { eventsMs: 30 * 24 * 60 * 60 * 1000, claimsMs: 7 * 24 * 60 * 60 * 1000 },
    receive: {
      mode: "enqueue",
      outbox: paymentsOutbox,
      intent: "process-webhook",
      store: webhookEvents,
      unitOfWork,
    },
  });
  // Mounted through the HTTP adapter on the route the legacy console already
  // calls: the event id travels in the `:id` segment (named explicitly as a
  // cross-check), authenticated like any operation and gated by
  // ship.webhooks:replay.
  const replay = defineWebhookReplay({
    id: "payments.webhook-replay",
    webhooks: [stripe],
    unitOfWork,
    store: webhookEvents,
    transport: { path: "/webhooks/:id/retry", eventIdParameter: "id" },
  });
  const cleanup = defineWebhookCleanup({
    id: "payments.webhook-cleanup",
    webhooks: [stripe],
    store: webhookEvents,
    clock,
  });
  return { stripe, replay, cleanup };
}

/**
 * Inline: an inbound SMS is answered with TwiML (`text/xml`) as soon as its
 * signature verifies, and a delivery status callback is acknowledged with a
 * bodiless 200, which is the wire form Twilio expects from both.
 */
export function createMessagingWebhooks(secrets: WebhookSecrets) {
  const twilio = webhookVerifierToken({
    verifier: twilioWebhookVerifier(),
    secret: secrets.twilio,
  });
  const inboundSms = defineWebhook({
    id: "messaging.inbound-sms",
    path: "/webhooks/twilio/sms",
    provider: twilio,
    body: { maxBytes: 16_384, mediaTypes: ["application/x-www-form-urlencoded"] },
    idempotency: {
      windowMs: 24 * 60 * 60 * 1000,
      store: idempotencyStore,
      inFlight: { kind: "wait", maxMs: 2_000 },
    },
    response: { mode: "text", contentType: "text/xml" },
    transaction: "none",
    dependencies: {},
    handler: () => INBOUND_SMS_TWIML,
  });
  const smsStatus = defineWebhook({
    id: "messaging.sms-status",
    path: "/webhooks/twilio/sms-status",
    provider: twilio,
    body: { maxBytes: 16_384, mediaTypes: ["application/x-www-form-urlencoded"] },
    idempotency: {
      windowMs: 24 * 60 * 60 * 1000,
      store: idempotencyStore,
      inFlight: { kind: "retry", status: 409 },
    },
    response: { mode: "empty" },
    transaction: "none",
    dependencies: {},
    handler: () => undefined,
  });
  return { inboundSms, smsStatus };
}
