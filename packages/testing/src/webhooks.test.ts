import {
  defineOutbox,
  effectDependency,
  outboxIntent,
  webhookSecret,
  webhookVerifierToken,
} from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createInMemoryIdempotencyStore, createInMemoryOutbox } from "./outbox.js";
import { createInMemoryWebhookEventStore, fakeWebhookProvider } from "./webhooks.js";

const notifier = effectDependency<{ send(): Promise<void> }>("fixture.notifier", {
  delivery: "immediate",
});
const outbox = defineOutbox({
  id: "fixture.outbox",
  intents: {
    process: outboxIntent({
      payload: z.object({ eventId: z.string() }),
      effect: notifier,
      perform: async () => undefined,
    }),
  },
});

function event(id: string, receivedAt: Date, webhookId = "ingress.hook") {
  return {
    id,
    webhookId,
    provider: "fake-provider",
    requestId: `req-${id}`,
    receivedAt,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(`{"id":"${id}"}`),
  };
}

describe("createInMemoryWebhookEventStore", () => {
  it("records, links and reads events with copied bodies", async () => {
    const store = createInMemoryWebhookEventStore();
    const body = new Uint8Array([1, 2, 3]);
    await store.record({}, { ...event("e1", new Date(1000)), body });
    body[0] = 9;
    await store.link({}, "e1", "fixture.outbox:1");
    await expect(store.read("e1")).resolves.toMatchObject({
      id: "e1",
      outboxRecordId: "fixture.outbox:1",
      body: new Uint8Array([1, 2, 3]),
    });
    await expect(store.read("missing")).resolves.toBeUndefined();
    await expect(store.record({}, event("e1", new Date(1000)))).rejects.toThrow(
      /already recorded/u,
    );
    await expect(store.link({}, "nope", "x")).rejects.toThrow(/not recorded/u);
    expect(store.events().map((item) => item.id)).toEqual(["e1"]);
    store.reset();
    expect(store.events()).toEqual([]);
  });

  it("lists events newest first, filtered by webhook and received-before", async () => {
    const store = createInMemoryWebhookEventStore();
    await store.record({}, event("e1", new Date(1000)));
    await store.record({}, event("e2", new Date(2000), "ingress.other"));
    await store.record({}, event("e3", new Date(3000)));
    expect((await store.list({ limit: 10 })).map((item) => item.id)).toEqual(["e3", "e2", "e1"]);
    expect(
      (await store.list({ webhookId: "ingress.hook", limit: 10 })).map((item) => item.id),
    ).toEqual(["e3", "e1"]);
    expect((await store.list({ before: new Date(3000), limit: 1 })).map((item) => item.id)).toEqual(
      ["e2"],
    );
  });

  it("cleans up dispatched events past retention but never undispatched ones", async () => {
    const backend = createInMemoryOutbox(outbox);
    const idempotency = createInMemoryIdempotencyStore();
    const store = createInMemoryWebhookEventStore({ outbox: backend, idempotency });
    const now = new Date("2026-09-18T12:00:00.000Z");
    const [pending, done] = await backend.record({}, [
      { intentId: "process", payload: { eventId: "old-pending" }, availableAt: now },
      { intentId: "process", payload: { eventId: "old-done" }, availableAt: now },
    ]);
    await store.record({}, event("old-pending", new Date(now.getTime() - 10_000)));
    await store.link({}, "old-pending", (pending as { recordId: string }).recordId);
    await store.record({}, event("old-done", new Date(now.getTime() - 10_000)));
    await store.link({}, "old-done", (done as { recordId: string }).recordId);
    await store.record({}, event("fresh", now));
    await store.record({}, event("other-hook", new Date(0), "other.hook"));
    await store.record({}, event("unlinked", new Date(0)));
    const [claimed] = await backend.claimDue(now, 10, 1000);
    const doneRecordId = (done as { recordId: string }).recordId;
    await backend.complete(claimed?.id === doneRecordId ? doneRecordId : doneRecordId, now);
    await idempotency.claim("ingress.hook:e-old", 1, { now: new Date(0) });
    await idempotency.claim("ingress.hook:e-new", 60_000, { now });
    await idempotency.claim("other.hook:e-old", 1, { now: new Date(0) });

    const result = await store.cleanup({
      webhookId: "ingress.hook",
      eventsBefore: new Date(now.getTime() - 5_000),
      claimsBefore: now,
      claimKeyPrefix: "ingress.hook:",
    });

    expect(result).toEqual({ eventsDeleted: 2, claimsDeleted: 1 });
    expect(
      store
        .events()
        .map((item) => item.id)
        .sort(),
    ).toEqual(["fresh", "old-pending", "other-hook"]);
    await expect(idempotency.claim("ingress.hook:e-new", 1, { now })).resolves.toBe("in-flight");
    await expect(idempotency.claim("other.hook:e-old", 1, { now })).resolves.toBe("claimed");
  });
});

describe("fakeWebhookProvider", () => {
  const provider = fakeWebhookProvider();
  const secret = "whsec_fixture";
  const now = new Date("2026-09-18T12:00:00.000Z");
  const rawBody = new TextEncoder().encode('{"id":"evt_1","amount":10}');
  const request = (headers: Readonly<Record<string, string>>, body = rawBody, key = secret) => ({
    headers,
    rawBody: body,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/fake",
    secret: key,
    now,
  });

  it("declares its guarantees and sensitive header through the public contract", () => {
    expect(provider.verifier.id).toBe("fake-provider");
    expect(provider.verifier.guarantees).toEqual({
      signature: true,
      freshness: true,
      replay: false,
    });
    expect(provider.verifier.sensitiveHeaders).toEqual(["x-fake-provider-signature"]);
    const token = webhookVerifierToken({
      verifier: provider.verifier,
      secret: webhookSecret(secret),
    });
    expect(token.provider).toBe("fake-provider");
  });

  it("verifies a signed sample and reports the event id and timestamp", async () => {
    const headers = await provider.sign({ rawBody, secret, eventId: "evt_1", timestamp: now });
    await expect(provider.verifier.verify(request(headers))).resolves.toEqual({
      ok: true,
      eventId: "evt_1",
      timestamp: now,
    });
  });

  it("rejects a bad signature, tampered content, a wrong secret, and stale or missing timestamps", async () => {
    const headers = await provider.sign({ rawBody, secret, eventId: "evt_1", timestamp: now });
    await expect(
      provider.verifier.verify(request({ ...headers, "x-fake-provider-signature": "00" })),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(
      provider.verifier.verify(
        request(headers, new TextEncoder().encode('{"id":"evt_1","amount":99}')),
      ),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(provider.verifier.verify(request(headers, rawBody, "other"))).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    const stale = await provider.sign({
      rawBody,
      secret,
      eventId: "evt_1",
      timestamp: new Date(now.getTime() - 6 * 60_000),
    });
    await expect(provider.verifier.verify(request(stale))).resolves.toEqual({
      ok: false,
      reason: "timestamp-stale",
    });
    await expect(provider.verifier.verify(request({}))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    await expect(
      provider.verifier.verify(request({ "x-fake-provider-signature": "ab" })),
    ).resolves.toEqual({ ok: false, reason: "timestamp-missing" });
    await expect(
      provider.verifier.verify(
        request({ ...headers, "x-fake-provider-signature": "zz", "x-fake-provider-event-id": "e" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
  });

  it("supports a custom id and tolerance", async () => {
    const custom = fakeWebhookProvider({ id: "partner", toleranceMs: 1_000 });
    const headers = await custom.sign({ rawBody: "text", secret, eventId: "e", timestamp: now });
    expect(Object.keys(headers)).toEqual([
      "x-partner-signature",
      "x-partner-timestamp",
      "x-partner-event-id",
    ]);
    await expect(
      custom.verifier.verify({
        ...request(headers, new TextEncoder().encode("text")),
        now: new Date(now.getTime() + 999),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      custom.verifier.verify({
        ...request(headers, new TextEncoder().encode("text")),
        now: new Date(now.getTime() + 2_000),
      }),
    ).resolves.toEqual({ ok: false, reason: "timestamp-stale" });
  });
});
