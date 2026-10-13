/**
 * Webhook lane: bursts of Stripe-signed events into the consumer's
 * `payments.stripe-webhook` (enqueue mode) through the Hono adapter. Every
 * request is verified against the exact bytes; one in twenty is tampered after
 * signing and must be rejected with 401 without touching the store.
 */
import { stripeSignatureHeader } from "@sixthsummit/ship-webhooks/stripe";
import { type ComposedApplication, STRIPE_SECRET } from "../compose.js";
import type { CapacityConfig } from "../config.js";
import { type Distribution, distribution, sleep, withConcurrency } from "../stats.js";

const TAMPER_EVERY = 20;

export interface WebhookWindow {
  readonly bursts: number;
  readonly sent: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unexpected: number;
  readonly latencyMs: Distribution;
}

export interface WebhookLaneSummary extends WebhookWindow {
  readonly tampered: number;
  /** The slowest burst's p95 and the burst that produced it. */
  readonly worstBurst: { readonly index: number; readonly p95: number; readonly max: number };
  readonly unexpectedStatuses: Readonly<Record<string, number>>;
}

export function createWebhookLane(composed: ComposedApplication, config: CapacityConfig) {
  const totals = { bursts: 0, sent: 0, accepted: 0, rejected: 0, unexpected: 0, tampered: 0 };
  const unexpectedStatuses: Record<string, number> = {};
  const allLatencies: number[] = [];
  let windowLatencies: number[] = [];
  let windowStart = { ...totals };
  let worstBurst = { index: -1, p95: 0, max: 0 };
  /** Never restarts, so warm-up and measured bursts never reuse a provider event id. */
  let burst = 0;

  const deliver = async (burst: number, index: number) => {
    const tampered = index % TAMPER_EVERY === TAMPER_EVERY - 1;
    const body = JSON.stringify({
      id: `evt_capacity_${burst}_${index}`,
      type: "invoice.paid",
      data: { object: { amount: 1_000 + index, burst } },
    });
    const signature = await stripeSignatureHeader({ secret: STRIPE_SECRET, rawBody: body });
    const started = performance.now();
    const response = await composed.http.request("/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: tampered ? body.replace('"type":"invoice.paid"', '"type":"invoice.void"') : body,
    });
    await response.arrayBuffer();
    const latency = performance.now() - started;
    allLatencies.push(latency);
    windowLatencies.push(latency);
    totals.sent += 1;
    if (tampered) totals.tampered += 1;
    const expected = tampered ? 401 : 202;
    if (response.status === expected) {
      if (tampered) totals.rejected += 1;
      else totals.accepted += 1;
    } else {
      totals.unexpected += 1;
      const key = `${tampered ? "tampered" : "valid"}:${response.status}`;
      unexpectedStatuses[key] = (unexpectedStatuses[key] ?? 0) + 1;
    }
    return latency;
  };

  return {
    run: async (stopAt: number) => {
      while (Date.now() < stopAt) {
        const burstStartedAt = Date.now();
        const latencies: number[] = [];
        await withConcurrency(
          config.webhookConcurrency,
          Array.from({ length: config.webhookBurstSize }, (_, index) => async () => {
            latencies.push(await deliver(burst, index));
          }),
        );
        const summary = distribution(latencies);
        if (summary.p95 > worstBurst.p95) {
          worstBurst = { index: burst, p95: summary.p95, max: summary.max };
        }
        totals.bursts += 1;
        burst += 1;
        const wait = burstStartedAt + config.webhookBurstIntervalSeconds * 1_000 - Date.now();
        if (wait > 0) await sleep(Math.min(wait, Math.max(0, stopAt - Date.now())));
      }
    },
    /** Forgets everything counted so far (end of warm-up). */
    reset: () => {
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = 0;
      for (const key of Object.keys(unexpectedStatuses)) delete unexpectedStatuses[key];
      allLatencies.length = 0;
      windowLatencies = [];
      windowStart = { ...totals };
      worstBurst = { index: -1, p95: 0, max: 0 };
    },
    window: (): WebhookWindow => {
      const window: WebhookWindow = {
        bursts: totals.bursts - windowStart.bursts,
        sent: totals.sent - windowStart.sent,
        accepted: totals.accepted - windowStart.accepted,
        rejected: totals.rejected - windowStart.rejected,
        unexpected: totals.unexpected - windowStart.unexpected,
        latencyMs: distribution(windowLatencies),
      };
      windowStart = { ...totals };
      windowLatencies = [];
      return window;
    },
    summary: (): WebhookLaneSummary => ({
      ...totals,
      latencyMs: distribution(allLatencies),
      worstBurst,
      unexpectedStatuses,
    }),
  };
}

export type WebhookLane = ReturnType<typeof createWebhookLane>;
