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
 * Slack: `X-Slack-Signature: v0=<hex>` with `X-Slack-Request-Timestamp`,
 * where the hex is HMAC-SHA256(signing secret, `v0:${timestamp}:${rawBody}`).
 * The signed timestamp bounds request age. The `event_id` of an Events API
 * payload is reported as the event id when present in the signed body.
 */
export interface SlackWebhookVerifierOptions {
  readonly toleranceMs?: number;
  readonly id?: string;
}

export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const VERSION = "v0";
const DEFAULT_TOLERANCE_MS = 5 * 60_000;

export function slackWebhookVerifier(options: SlackWebhookVerifierOptions = {}): WebhookVerifier {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  return defineWebhookVerifier({
    id: options.id ?? "slack",
    guarantees: { signature: true, freshness: true, replay: false },
    sensitiveHeaders: [SLACK_SIGNATURE_HEADER],
    verify: async ({ headers, rawBody, secret, now }) => {
      const signature = headers[SLACK_SIGNATURE_HEADER];
      const timestampText = headers[SLACK_TIMESTAMP_HEADER];
      if (signature === undefined) return { ok: false, reason: "missing-signature" };
      if (timestampText === undefined) return { ok: false, reason: "timestamp-missing" };
      const timestamp = unixSecondsToDate(timestampText);
      if (!timestamp) return { ok: false, reason: "malformed-signature" };
      if (!isWithinTolerance(timestamp, now, toleranceMs)) {
        return { ok: false, reason: "timestamp-stale" };
      }
      if (!signature.startsWith(`${VERSION}=`)) return { ok: false, reason: "malformed-signature" };
      const presented = hexToBytes(signature.slice(VERSION.length + 1));
      if (!presented || presented.byteLength !== 32) {
        return { ok: false, reason: "malformed-signature" };
      }
      const expected = await hmac("SHA-256", secret, signedPayload(timestampText, rawBody));
      if (!constantTimeEqual(expected, presented)) {
        return { ok: false, reason: "signature-mismatch" };
      }
      const eventId = signedEventId(rawBody);
      return { ok: true, timestamp, ...(eventId ? { eventId } : {}) };
    },
  });
}

/** Test helper: builds the Slack signature and timestamp headers for `rawBody`. */
export async function slackSignatureHeaders(input: {
  readonly secret: string;
  readonly rawBody: Uint8Array | string;
  readonly timestamp?: Date;
}): Promise<Readonly<Record<string, string>>> {
  const seconds = String(Math.floor((input.timestamp ?? new Date()).getTime() / 1000));
  const body = typeof input.rawBody === "string" ? utf8Bytes(input.rawBody) : input.rawBody;
  const signature = bytesToHex(await hmac("SHA-256", input.secret, signedPayload(seconds, body)));
  return Object.freeze({
    [SLACK_SIGNATURE_HEADER]: `${VERSION}=${signature}`,
    [SLACK_TIMESTAMP_HEADER]: seconds,
  });
}

function signedPayload(timestamp: string, rawBody: Uint8Array): Uint8Array {
  return concatBytes(utf8Bytes(`${VERSION}:${timestamp}:`), rawBody);
}

function signedEventId(rawBody: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(utf8Text(rawBody));
    const id =
      typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "event_id") : undefined;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}
