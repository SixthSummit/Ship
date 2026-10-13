import type { WebhookVerifier } from "@sixthsummit/ship-core";
import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  constantTimeEqual,
  defineWebhookVerifier,
  hmac,
  isWithinTolerance,
  unixSecondsToDate,
  utf8Bytes,
} from "@sixthsummit/ship-core";

/**
 * Resend delivers through Svix (the Standard Webhooks scheme): `svix-id`,
 * `svix-timestamp` and `svix-signature` (`v1,<base64> v1,<base64> ...`),
 * where each signature is HMAC-SHA256(key, `${id}.${timestamp}.${rawBody}`)
 * and the key is the base64 payload after the `whsec_` prefix. The
 * `webhook-*` header aliases are accepted. The signed timestamp bounds request
 * age and the signed `svix-id` is the event id.
 */
export interface ResendWebhookVerifierOptions {
  readonly toleranceMs?: number;
  readonly id?: string;
}

const HEADER_PREFIXES = ["svix", "webhook"] as const;
const SECRET_PREFIX = "whsec_";
const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export function resendWebhookVerifier(options: ResendWebhookVerifierOptions = {}): WebhookVerifier {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  return defineWebhookVerifier({
    id: options.id ?? "resend",
    guarantees: { signature: true, freshness: true, replay: false },
    sensitiveHeaders: HEADER_PREFIXES.map((prefix) => `${prefix}-signature`),
    verify: async ({ headers, rawBody, secret, now }) => {
      const found = HEADER_PREFIXES.map((prefix) => ({
        id: headers[`${prefix}-id`],
        timestamp: headers[`${prefix}-timestamp`],
        signature: headers[`${prefix}-signature`],
      })).find((candidate) => candidate.signature !== undefined);
      if (!found) return { ok: false, reason: "missing-signature" };
      if (found.timestamp === undefined) return { ok: false, reason: "timestamp-missing" };
      if (found.id === undefined || found.id.length === 0) {
        return { ok: false, reason: "malformed-signature" };
      }
      const timestamp = unixSecondsToDate(found.timestamp);
      if (!timestamp) return { ok: false, reason: "malformed-signature" };
      if (!isWithinTolerance(timestamp, now, toleranceMs)) {
        return { ok: false, reason: "timestamp-stale" };
      }
      const presented = (found.signature as string)
        .split(" ")
        .filter((entry) => entry.startsWith("v1,"))
        .map((entry) => base64ToBytes(entry.slice(3)));
      if (presented.length === 0 || presented.some((signature) => signature === undefined)) {
        return { ok: false, reason: "malformed-signature" };
      }
      const expected = await hmac(
        "SHA-256",
        signingKey(secret),
        signedPayload(found.id, found.timestamp, rawBody),
      );
      const matched = presented.some(
        (signature) => signature !== undefined && constantTimeEqual(expected, signature),
      );
      return matched
        ? { ok: true, eventId: found.id, timestamp }
        : { ok: false, reason: "signature-mismatch" };
    },
  });
}

/** Test helper: builds the `svix-*` headers a real Resend delivery would carry. */
export async function resendSignatureHeaders(input: {
  readonly secret: string;
  readonly rawBody: Uint8Array | string;
  readonly id: string;
  readonly timestamp?: Date;
}): Promise<Readonly<Record<string, string>>> {
  const seconds = String(Math.floor((input.timestamp ?? new Date()).getTime() / 1000));
  const body = typeof input.rawBody === "string" ? utf8Bytes(input.rawBody) : input.rawBody;
  const signature = bytesToBase64(
    await hmac("SHA-256", signingKey(input.secret), signedPayload(input.id, seconds, body)),
  );
  return Object.freeze({
    "svix-id": input.id,
    "svix-timestamp": seconds,
    "svix-signature": `v1,${signature}`,
  });
}

/** The raw HMAC key: base64-decoded after the `whsec_` prefix (a bare secret is used as-is). */
function signingKey(secret: string): Uint8Array {
  if (!secret.startsWith(SECRET_PREFIX)) return utf8Bytes(secret);
  const decoded = base64ToBytes(secret.slice(SECRET_PREFIX.length));
  if (!decoded) {
    throw new TypeError(
      "Resend webhook secret must be whsec_<base64>; check the configured secret",
    );
  }
  return decoded;
}

function signedPayload(id: string, timestamp: string, rawBody: Uint8Array): Uint8Array {
  return concatBytes(utf8Bytes(`${id}.${timestamp}.`), rawBody);
}
