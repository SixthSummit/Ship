import type {
  StoredWebhookEvent,
  WebhookEventCleanupRequest,
  WebhookEventCleanupResult,
  WebhookEventInput,
  WebhookEventQuery,
  WebhookEventStore,
  WebhookVerifier,
} from "@sixthsummit/ship-core";
import {
  bytesToHex,
  constantTimeEqual,
  defineWebhookVerifier,
  hexToBytes,
  hmac,
  isWithinTolerance,
  unixSecondsToDate,
  utf8Bytes,
} from "@sixthsummit/ship-core";
import type { InMemoryIdempotencyStore, InMemoryOutbox } from "./outbox.js";

/**
 * Deterministic in-memory webhook event store for unit tests.
 *
 * It ignores the unit-of-work scope, so recorded events are visible as soon
 * as `record()` resolves even if the surrounding fake transaction later
 * fails. Use the Drizzle store with a real database to prove atomicity.
 */
export interface InMemoryWebhookEventStore extends WebhookEventStore {
  readonly adapter: "memory";
  /** Snapshot of every stored event, oldest first. */
  readonly events: () => readonly StoredWebhookEvent[];
  readonly reset: () => void;
}

export interface InMemoryWebhookEventStoreOptions {
  /** Consulted by cleanup so an event with an undispatched intent is retained. */
  readonly outbox?: InMemoryOutbox;
  /** Consulted by cleanup to purge expired claims under the webhook's key prefix. */
  readonly idempotency?: InMemoryIdempotencyStore;
}

export function createInMemoryWebhookEventStore(
  options: InMemoryWebhookEventStoreOptions = {},
): InMemoryWebhookEventStore {
  const rows = new Map<string, StoredWebhookEvent>();

  const record = async (_scope: object, event: WebhookEventInput): Promise<void> => {
    if (rows.has(event.id)) throw new Error(`webhook event ${event.id} already recorded`);
    rows.set(
      event.id,
      Object.freeze({
        ...event,
        headers: Object.freeze({ ...event.headers }),
        body: new Uint8Array(event.body),
      }),
    );
  };

  const link = async (_scope: object, eventId: string, outboxRecordId: string): Promise<void> => {
    const existing = rows.get(eventId);
    if (!existing) throw new Error(`webhook event ${eventId} is not recorded`);
    rows.set(eventId, Object.freeze({ ...existing, outboxRecordId }));
  };

  const read = async (eventId: string): Promise<StoredWebhookEvent | undefined> =>
    rows.get(eventId);

  const list = async (query: WebhookEventQuery): Promise<readonly StoredWebhookEvent[]> =>
    Object.freeze(
      [...rows.values()]
        .filter(
          (event) =>
            (query.webhookId === undefined || event.webhookId === query.webhookId) &&
            (query.before === undefined || event.receivedAt.getTime() < query.before.getTime()),
        )
        .sort((left, right) => right.receivedAt.getTime() - left.receivedAt.getTime())
        .slice(0, query.limit),
    );

  const cleanup = async (
    request: WebhookEventCleanupRequest,
  ): Promise<WebhookEventCleanupResult> => {
    let eventsDeleted = 0;
    for (const [id, event] of rows) {
      if (event.webhookId !== request.webhookId) continue;
      if (event.receivedAt.getTime() >= request.eventsBefore.getTime()) continue;
      if (
        event.outboxRecordId !== undefined &&
        isUndispatched(options.outbox, event.outboxRecordId)
      ) {
        continue;
      }
      rows.delete(id);
      eventsDeleted += 1;
    }
    const claimsDeleted =
      options.idempotency?.purgeExpired(request.claimsBefore, request.claimKeyPrefix) ?? 0;
    return Object.freeze({ eventsDeleted, claimsDeleted });
  };

  return Object.freeze({
    kind: "ship.webhook-event-store" as const,
    adapter: "memory" as const,
    record,
    link,
    read,
    list,
    cleanup,
    events: () =>
      Object.freeze(
        [...rows.values()].sort(
          (left, right) => left.receivedAt.getTime() - right.receivedAt.getTime(),
        ),
      ),
    reset: () => rows.clear(),
  });
}

function isUndispatched(outbox: InMemoryOutbox | undefined, recordId: string): boolean {
  const record = outbox?.records().find((row) => row.id === recordId);
  return record !== undefined && (record.status === "pending" || record.status === "claimed");
}

// ---------------------------------------------------------------------------
// Fake provider: a consumer-defined verifier built only from public contracts
// ---------------------------------------------------------------------------

export interface FakeWebhookProviderOptions {
  /** Verifier and default provider id. Defaults to `fake-provider`. */
  readonly id?: string;
  /** Signature tolerance in milliseconds. Defaults to five minutes. */
  readonly toleranceMs?: number;
}

export interface FakeWebhookSignature {
  readonly rawBody: Uint8Array | string;
  readonly secret: string;
  readonly eventId: string;
  /** Signed instant; defaults to now. */
  readonly timestamp?: Date;
}

export interface FakeWebhookProvider {
  readonly verifier: WebhookVerifier;
  /** Produces the headers a real provider would send for `rawBody`. */
  sign(signature: FakeWebhookSignature): Promise<Readonly<Record<string, string>>>;
}

/**
 * A self-contained HMAC provider proving that a verifier written outside the
 * framework binds through `defineWebhookVerifier` and `webhookVerifierToken`
 * alone, with no registry. The scheme signs `${timestamp}.${eventId}.${body}`
 * with HMAC-SHA256 and carries the event id and timestamp in headers.
 */
export function fakeWebhookProvider(options: FakeWebhookProviderOptions = {}): FakeWebhookProvider {
  const id = options.id ?? "fake-provider";
  const toleranceMs = options.toleranceMs ?? 5 * 60_000;
  const signatureHeader = `x-${id}-signature`;
  const timestampHeader = `x-${id}-timestamp`;
  const eventHeader = `x-${id}-event-id`;

  const verifier = defineWebhookVerifier({
    id,
    guarantees: { signature: true, freshness: true, replay: false },
    sensitiveHeaders: [signatureHeader],
    verify: async ({ headers, rawBody, secret, now }) => {
      const presented = headers[signatureHeader];
      const eventId = headers[eventHeader];
      if (presented === undefined) return { ok: false, reason: "missing-signature" };
      const timestamp = unixSecondsToDate(headers[timestampHeader]);
      if (!timestamp) return { ok: false, reason: "timestamp-missing" };
      if (!isWithinTolerance(timestamp, now, toleranceMs)) {
        return { ok: false, reason: "timestamp-stale" };
      }
      const presentedBytes = hexToBytes(presented);
      if (!presentedBytes || !eventId) return { ok: false, reason: "malformed-signature" };
      const expected = await hmac(
        "SHA-256",
        secret,
        payload(headers[timestampHeader] as string, eventId, rawBody),
      );
      return constantTimeEqual(expected, presentedBytes)
        ? { ok: true, eventId, timestamp }
        : { ok: false, reason: "signature-mismatch" };
    },
  });

  return Object.freeze({
    verifier,
    sign: async ({ rawBody, secret, eventId, timestamp = new Date() }: FakeWebhookSignature) => {
      const seconds = String(Math.floor(timestamp.getTime() / 1000));
      const body = typeof rawBody === "string" ? utf8Bytes(rawBody) : rawBody;
      const signature = bytesToHex(await hmac("SHA-256", secret, payload(seconds, eventId, body)));
      return Object.freeze({
        [signatureHeader]: signature,
        [timestampHeader]: seconds,
        [eventHeader]: eventId,
      });
    },
  });
}

function payload(timestamp: string, eventId: string, rawBody: Uint8Array): Uint8Array {
  const prefix = utf8Bytes(`${timestamp}.${eventId}.`);
  const joined = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  joined.set(prefix, 0);
  joined.set(rawBody, prefix.byteLength);
  return joined;
}
