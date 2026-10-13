import type { WebhookVerifier } from "@sixthsummit/ship-core";
import {
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  defineWebhookVerifier,
  hexToBytes,
  hmac,
  isWithinTolerance,
  unixSecondsToDate,
  utf8Bytes,
  utf8Text,
} from "@sixthsummit/ship-core";

/**
 * Stripe: `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]` where
 * each `v1` is HMAC-SHA256(secret, `${t}.${rawBody}`). The signed timestamp
 * bounds request age; replay inside the tolerance window is caught by the
 * webhook's idempotency key, which defaults to the signed event `id`.
 */
export interface StripeWebhookVerifierOptions {
  /** Maximum accepted clock skew; Stripe recommends five minutes. */
  readonly toleranceMs?: number;
  /** Verifier id; defaults to `stripe`. */
  readonly id?: string;
}

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export function stripeWebhookVerifier(options: StripeWebhookVerifierOptions = {}): WebhookVerifier {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  return defineWebhookVerifier({
    id: options.id ?? "stripe",
    guarantees: { signature: true, freshness: true, replay: false },
    sensitiveHeaders: [STRIPE_SIGNATURE_HEADER],
    verify: async ({ headers, rawBody, secret, now }) => {
      const header = headers[STRIPE_SIGNATURE_HEADER];
      if (header === undefined) return { ok: false, reason: "missing-signature" };
      const parts = parseSignatureHeader(header);
      const timestampText = parts.get("t")?.[0];
      const presented = (parts.get("v1") ?? []).map(hexToBytes);
      if (
        timestampText === undefined ||
        presented.length === 0 ||
        presented.some((signature) => signature === undefined || signature.byteLength !== 32)
      ) {
        return { ok: false, reason: "malformed-signature" };
      }
      const timestamp = unixSecondsToDate(timestampText);
      if (!timestamp) return { ok: false, reason: "malformed-signature" };
      if (!isWithinTolerance(timestamp, now, toleranceMs)) {
        return { ok: false, reason: "timestamp-stale" };
      }
      const expected = await hmac("SHA-256", secret, signedPayload(timestampText, rawBody));
      const matched = presented.some(
        (signature) => signature !== undefined && constantTimeEqual(expected, signature),
      );
      if (!matched) return { ok: false, reason: "signature-mismatch" };
      const eventId = signedEventId(rawBody);
      return { ok: true, timestamp, ...(eventId ? { eventId } : {}) };
    },
  });
}

/** Test helper: builds the `Stripe-Signature` value a real delivery would carry. */
export async function stripeSignatureHeader(input: {
  readonly secret: string;
  readonly rawBody: Uint8Array | string;
  readonly timestamp?: Date;
}): Promise<string> {
  const seconds = String(Math.floor((input.timestamp ?? new Date()).getTime() / 1000));
  const body = typeof input.rawBody === "string" ? utf8Bytes(input.rawBody) : input.rawBody;
  const signature = bytesToHex(await hmac("SHA-256", input.secret, signedPayload(seconds, body)));
  return `t=${seconds},v1=${signature}`;
}

function signedPayload(timestamp: string, rawBody: Uint8Array): Uint8Array {
  return concatBytes(utf8Bytes(`${timestamp}.`), rawBody);
}

function parseSignatureHeader(header: string): ReadonlyMap<string, readonly string[]> {
  const parts = new Map<string, string[]>();
  for (const element of header.split(",")) {
    const separator = element.indexOf("=");
    if (separator <= 0) continue;
    const key = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    const values = parts.get(key) ?? [];
    values.push(value);
    parts.set(key, values);
  }
  return parts;
}

/** The event `id` from the verified JSON body; only signed bytes are trusted for the key. */
function signedEventId(rawBody: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(utf8Text(rawBody));
    const id =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "id") : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}
