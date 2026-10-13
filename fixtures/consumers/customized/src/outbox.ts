import {
  defineOutbox,
  effectDependency,
  outboxIntent,
  webhookIntent,
} from "@sixthsummit/ship-core";
import { z } from "zod";
import type { PaymentEventSink, ReportNotifier } from "./effects.js";

/** The single immediate notification effect, shared by the direct and durable paths. */
export const reportNotifier = effectDependency<ReportNotifier>("reports.notifier", {
  delivery: "immediate",
});

/** Report notifications the application expects to record per second, sustained. */
export const REPORTS_EXPECTED_RATE_PER_SECOND = 500;

/**
 * Durable report notifications. `reports.request` records the intent in the
 * same transaction as the request row; `reports.outbox.dispatch` performs it
 * later with at-least-once delivery. The consumer owns the payload meaning.
 * The declared expected rate lets the compiler check it against the
 * dispatcher's declared capacity (`SHIP_OUTBOX_DISPATCH_CAPACITY_BELOW_PUBLISH_RATE`).
 */
export const reportsOutbox = defineOutbox({
  id: "reports.outbox",
  retention: { completedMs: 7 * 24 * 60 * 60 * 1000, deadLetteredMs: 30 * 24 * 60 * 60 * 1000 },
  expectedRatePerSecond: REPORTS_EXPECTED_RATE_PER_SECOND,
  intents: {
    notify: outboxIntent({
      payload: z.object({
        tenantId: z.string().min(1),
        recipient: z.string().email(),
        subject: z.string().min(1),
        requestedBy: z.string().min(1),
      }),
      effect: reportNotifier,
      perform: ({ effect, payload }) => effect.send(payload),
    }),
  },
});

/** The ledger effect performed for each durably received payment webhook. */
export const paymentSink = effectDependency<PaymentEventSink>("payments.sink", {
  delivery: "immediate",
});

/**
 * Receive-then-process for Stripe: `payments.stripe-webhook` records the raw
 * event and this intent in one transaction; `payments.outbox.dispatch`
 * performs the sink effect afterwards with at-least-once delivery.
 */
export const paymentsOutbox = defineOutbox({
  id: "payments.outbox",
  retention: { completedMs: 7 * 24 * 60 * 60 * 1000, deadLetteredMs: 30 * 24 * 60 * 60 * 1000 },
  intents: {
    "process-webhook": webhookIntent({
      effect: paymentSink,
      perform: ({ effect, event }) =>
        effect.record({ eventId: event.eventId, provider: event.provider }),
    }),
  },
});
