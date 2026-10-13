/**
 * Compat-versus-kernel webhook parity.
 *
 * The compatibility line verifies with `parseWebhook(c, { provider: "stripe" })`
 * and deduplicates with the `idempotency()` middleware keyed by an
 * `Idempotency-Key` header. The kernel line declares the same behaviour with
 * `defineWebhook` + the Stripe verifier and executor-enforced idempotency.
 * Identical recorded requests must produce identical accept/reject decisions
 * and identical handler execution counts.
 */
import {
  createApp,
  InMemoryCache,
  idempotency,
  parseWebhook,
  registerErrorHandlers,
} from "@sixthsummit/ship-api";
import {
  defineApp,
  defineModule,
  defineWebhook,
  idempotencyStoreDependency,
  valueProvider,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { createInMemoryIdempotencyStore } from "@sixthsummit/ship-testing";
import { stripeSignatureHeader, stripeWebhookVerifier } from "@sixthsummit/ship-webhooks/stripe";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHonoAdapter } from "./adapter.js";

const SECRET = "whsec_parity";
const storeToken = idempotencyStoreDependency("platform.idempotency");

interface RecordedRequest {
  readonly label: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

async function recordRequests(): Promise<readonly RecordedRequest[]> {
  const body = '{"id":"evt_parity_1","type":"invoice.paid"}';
  const valid = await stripeSignatureHeader({ secret: SECRET, rawBody: body });
  const stale = await stripeSignatureHeader({
    secret: SECRET,
    rawBody: body,
    timestamp: new Date(Date.now() - 20 * 60_000),
  });
  // The compat middleware keys on the client-supplied Idempotency-Key header, so
  // each recorded delivery carries its own key except the intentional duplicate.
  const base = (key: string) => ({ "content-type": "application/json", "idempotency-key": key });
  return [
    { label: "valid", body, headers: { ...base("k-valid"), "stripe-signature": valid } },
    { label: "duplicate", body, headers: { ...base("k-valid"), "stripe-signature": valid } },
    {
      label: "tampered",
      body: '{"id":"evt_parity_1","type":"invoice.void"}',
      headers: { ...base("k-tampered"), "stripe-signature": valid },
    },
    { label: "stale", body, headers: { ...base("k-stale"), "stripe-signature": stale } },
    { label: "unsigned", body, headers: base("k-unsigned") },
    {
      label: "wrong-secret",
      body,
      headers: {
        ...base("k-wrong"),
        "stripe-signature": await stripeSignatureHeader({ secret: "other", rawBody: body }),
      },
    },
  ];
}

function compatApp() {
  let executions = 0;
  const app = createApp();
  registerErrorHandlers(app);
  app.post("/webhooks/stripe", idempotency({ cache: new InMemoryCache() }), async (c) => {
    const { payload } = await parseWebhook<{ id: string }>(c, {
      provider: "stripe",
      secret: SECRET,
    });
    executions += 1;
    return c.json({ received: payload.id });
  });
  return { app, executions: () => executions };
}

function kernelApp() {
  let executions = 0;
  const webhook = defineWebhook({
    id: "ingress.stripe-webhook",
    path: "/webhooks/stripe",
    provider: webhookVerifierToken({
      verifier: stripeWebhookVerifier(),
      secret: webhookSecret(SECRET),
    }),
    body: { maxBytes: 65_536, mediaTypes: ["application/json"] },
    idempotency: {
      windowMs: 86_400_000,
      store: storeToken,
      inFlight: { kind: "retry", status: 409 },
    },
    output: { 200: z.object({ received: z.string() }) },
    successStatus: 200,
    transaction: "none",
    dependencies: {},
    handler: ({ event }) => {
      executions += 1;
      return { received: event.verified.eventId ?? "" };
    },
  });
  const application = defineApp({
    id: "parity",
    modules: [
      defineModule({
        id: "ingress",
        operations: [webhook.operation],
        providers: [valueProvider(storeToken, createInMemoryIdempotencyStore())],
        imports: [],
        exports: [],
      }),
    ],
  });
  return {
    app: createHonoAdapter(application, {
      webhooks: { publicBaseUrl: "https://parity.example.test" },
    }),
    executions: () => executions,
  };
}

describe("compat parseWebhook + idempotency versus kernel defineWebhook", () => {
  it("makes identical accept/reject decisions on identical recorded requests", async () => {
    const requests = await recordRequests();
    const compat = compatApp();
    const kernel = kernelApp();
    const decisions: Record<string, { compat: string; kernel: string }> = {};
    for (const request of requests) {
      const init = { method: "POST", headers: request.headers, body: request.body };
      const [compatResponse, kernelResponse] = await Promise.all([
        compat.app.request("/webhooks/stripe", init),
        kernel.app.request("/webhooks/stripe", init),
      ]);
      decisions[request.label] = {
        compat: decision(compatResponse.status),
        kernel: decision(kernelResponse.status),
      };
      if (request.label === "valid" || request.label === "duplicate") {
        await expect(compatResponse.json()).resolves.toEqual({ received: "evt_parity_1" });
        await expect(kernelResponse.json()).resolves.toEqual({ received: "evt_parity_1" });
      }
    }
    expect(decisions).toEqual({
      valid: { compat: "accepted", kernel: "accepted" },
      duplicate: { compat: "accepted", kernel: "accepted" },
      tampered: { compat: "rejected", kernel: "rejected" },
      stale: { compat: "rejected", kernel: "rejected" },
      unsigned: { compat: "rejected", kernel: "rejected" },
      "wrong-secret": { compat: "rejected", kernel: "rejected" },
    });
    expect(compat.executions()).toBe(1);
    expect(kernel.executions()).toBe(1);
  });

  it("documents the ordering divergence the kernel closes: replay never precedes verification", async () => {
    const [valid] = await recordRequests();
    const compat = compatApp();
    const kernel = kernelApp();
    const init = { method: "POST", headers: valid!.headers, body: valid!.body };
    expect((await compat.app.request("/webhooks/stripe", init)).status).toBe(200);
    expect((await kernel.app.request("/webhooks/stripe", init)).status).toBe(200);

    // Same key and body, signature stripped: the compat middleware replays the
    // stored response before parseWebhook runs; the kernel verifies first.
    const { "stripe-signature": _signature, ...unsignedHeaders } = valid!.headers;
    const unsigned = { method: "POST", headers: unsignedHeaders, body: valid!.body };
    expect((await compat.app.request("/webhooks/stripe", unsigned)).status).toBe(200);
    expect((await kernel.app.request("/webhooks/stripe", unsigned)).status).toBe(401);
  });
});

function decision(status: number): "accepted" | "rejected" | "other" {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 401) return "rejected";
  return "other";
}
