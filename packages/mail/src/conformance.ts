import type {
  MailLedger,
  MailProvider,
  MailSendRecord,
  MailSendRequest,
} from "@sixthsummit/ship-core";
import { isMailLedger, isMailProvider, MAIL_ORIGINAL_TO_HEADER } from "@sixthsummit/ship-core";

/** The minimal test-runner surface the conformance suites need (Vitest satisfies it). */
export interface MailConformanceTestApi {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void> | void, timeout?: number): void;
  beforeEach(body: () => Promise<void> | void, timeout?: number): void;
  afterEach(body: () => Promise<void> | void, timeout?: number): void;
  expect: (value: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: object): void;
    toHaveLength(expected: number): void;
    toBeUndefined(): void;
  };
}

export interface MailProviderHarness {
  readonly provider: MailProvider;
  /** Every request the provider forwarded, oldest first; the harness observes its own transport. */
  readonly forwarded: () => readonly MailSendRequest[];
}

export function conformanceRequest(overrides: Partial<MailSendRequest> = {}): MailSendRequest {
  return Object.freeze({
    envelope: Object.freeze({
      from: "Conformance <conformance@example.test>",
      to: Object.freeze(["ada@example.test", "Bob <bob@example.test>"]),
      cc: Object.freeze(["cc@example.test"]),
      replyTo: "support@example.test",
      subject: "Conformance message",
      html: "<p>Conformance</p>",
      text: "Conformance",
      headers: Object.freeze({ [MAIL_ORIGINAL_TO_HEADER]: "customer@example.test" }),
    }),
    idempotencyKey: "conformance:1",
    mailerId: "conformance.mailer",
    message: "ping",
    ...overrides,
  });
}

/**
 * Shared behavioral contract for `MailProvider` adapters: structural shape,
 * one forwarded request per `send`, the whole envelope and the idempotency key
 * reaching the transport, and repeated keys forwarded again (deduplication by
 * key is the provider service's or the ledger's job, never the adapter's).
 */
export function mailProviderConformance(
  name: string,
  createHarness: () => Promise<MailProviderHarness> | MailProviderHarness,
  api: MailConformanceTestApi,
): void {
  api.describe(`MailProvider conformance: ${name}`, () => {
    let harness: MailProviderHarness;
    api.beforeEach(async () => {
      harness = await createHarness();
    });

    api.it("is a structural MailProvider", () => {
      api.expect(isMailProvider(harness.provider)).toBe(true);
      api.expect(harness.provider.adapter).toBe(name);
    });

    api.it("forwards the full envelope and idempotency key exactly once per send", async () => {
      const request = conformanceRequest();
      const outcome = await harness.provider.send(request);
      api.expect(outcome.accepted).toBe(true);
      const forwarded = harness.forwarded();
      api.expect(forwarded).toHaveLength(1);
      api.expect(forwarded[0]).toMatchObject({
        idempotencyKey: "conformance:1",
        envelope: {
          from: request.envelope.from,
          to: [...request.envelope.to],
          cc: [...(request.envelope.cc ?? [])],
          replyTo: request.envelope.replyTo,
          subject: request.envelope.subject,
          html: request.envelope.html,
          text: request.envelope.text,
          headers: { [MAIL_ORIGINAL_TO_HEADER]: "customer@example.test" },
        },
      });
    });

    api.it("returns a provider message id when the service issues one", async () => {
      const outcome = await harness.provider.send(conformanceRequest({ idempotencyKey: "conformance:2" }));
      api.expect(outcome.accepted).toBe(true);
      if (outcome.accepted) {
        api.expect(typeof outcome.providerMessageId).toBe("string");
      }
    });

    api.it("forwards a repeated idempotency key again rather than silently dropping it", async () => {
      await harness.provider.send(conformanceRequest({ idempotencyKey: "conformance:3" }));
      await harness.provider.send(conformanceRequest({ idempotencyKey: "conformance:3" }));
      api.expect(harness.forwarded().map((item) => item.idempotencyKey)).toEqual([
        "conformance:3",
        "conformance:3",
      ]);
    });
  });
}

/**
 * Shared behavioral contract for `MailLedger` adapters: the claim state
 * machine that keeps a replayed delivery from calling the provider twice.
 */
export function mailLedgerConformance(
  name: string,
  createLedger: () => Promise<MailLedger> | MailLedger,
  api: MailConformanceTestApi,
): void {
  const base = {
    mailerId: "conformance.mailer",
    message: "ping",
    to: ["ada@example.test"],
    deliveredTo: ["ada@example.test"],
    intercepted: false,
    subject: "Conformance",
    provider: "log",
    leaseMs: 60_000,
  };
  api.describe(`MailLedger conformance: ${name}`, () => {
    let ledger: MailLedger;
    api.beforeEach(async () => {
      ledger = await createLedger();
    });

    api.it("is a structural MailLedger", () => {
      api.expect(isMailLedger(ledger)).toBe(true);
    });

    api.it("claims a new key once, answers a sent key from the ledger and lists by recipient", async () => {
      const now = new Date("2026-10-22T10:00:00.000Z");
      const first = await ledger.claim({ ...base, idempotencyKey: "k1", now });
      api.expect(first).toEqual({ outcome: "claimed", attempt: 1 });
      const live = await ledger.claim({ ...base, idempotencyKey: "k1", now });
      api.expect(live.outcome).toBe("in-flight");
      await ledger.markSent("k1", { providerMessageId: "msg-1", now });
      const sent = await ledger.claim({ ...base, idempotencyKey: "k1", now });
      api.expect(sent.outcome).toBe("sent");
      api.expect((sent as { record: MailSendRecord }).record).toMatchObject({
        idempotencyKey: "k1",
        status: "sent",
        attempts: 1,
        providerMessageId: "msg-1",
        to: ["ada@example.test"],
      });
      const listed = await ledger.list({ recipient: "ada@example.test", limit: 10 });
      api.expect(listed).toHaveLength(1);
      api.expect(await ledger.list({ recipient: "nobody@example.test", limit: 10 })).toHaveLength(0);
      api.expect((await ledger.find("k1"))?.status).toBe("sent");
      api.expect(await ledger.find("missing")).toBeUndefined();
    });

    api.it("retakes a failed row and a stale sending claim, counting attempts", async () => {
      const now = new Date("2026-10-22T10:00:00.000Z");
      await ledger.claim({ ...base, idempotencyKey: "k2", now });
      await ledger.markFailed("k2", { error: "429", now });
      api.expect((await ledger.find("k2"))).toMatchObject({ status: "failed", lastError: "429" });
      const second = await ledger.claim({ ...base, idempotencyKey: "k2", now });
      api.expect(second).toEqual({ outcome: "claimed", attempt: 2 });
      const later = new Date(now.getTime() + base.leaseMs + 1);
      const third = await ledger.claim({ ...base, idempotencyKey: "k2", now: later });
      api.expect(third).toEqual({ outcome: "claimed", attempt: 3 });
      // markFailed only applies to the live claim; a sent row is never demoted.
      await ledger.markSent("k2", { now: later });
      await ledger.markFailed("k2", { error: "late", now: later });
      api.expect((await ledger.find("k2"))?.status).toBe("sent");
    });

    api.it("deletes terminal rows older than the cutoff and keeps live claims", async () => {
      const old = new Date("2026-10-01T00:00:00.000Z");
      const recent = new Date("2026-10-22T10:00:00.000Z");
      await ledger.claim({ ...base, idempotencyKey: "old-sent", now: old });
      await ledger.markSent("old-sent", { now: old });
      await ledger.claim({ ...base, idempotencyKey: "old-live", now: old });
      await ledger.claim({ ...base, idempotencyKey: "recent", now: recent });
      await ledger.markSent("recent", { now: recent });
      api.expect(await ledger.cleanup({ before: new Date("2026-10-15T00:00:00.000Z") })).toEqual({
        deleted: 1,
      });
      api.expect((await ledger.list({ limit: 10 })).map((row) => row.idempotencyKey).sort()).toEqual([
        "old-live",
        "recent",
      ]);
    });
  });
}
