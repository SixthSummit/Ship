import type { WebhookVerifier } from "@sixthsummit/ship-core";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  constantTimeEqual,
  defineWebhookVerifier,
  digest,
  hmac,
  utf8Bytes,
  utf8Text,
} from "@sixthsummit/ship-core";

/**
 * Twilio: `X-Twilio-Signature` is base64(HMAC-SHA1(auth token, data)) where
 * data is the exact request URL Twilio called followed, for
 * `application/x-www-form-urlencoded` bodies, by every form parameter sorted
 * by key (and by value within a key) as `key + value`. For JSON bodies Twilio
 * signs the URL with a `bodySHA256=<hex>` query parameter instead.
 *
 * The URL is the framework's canonical URL derived from the declared public
 * base URL and operation path, so a reverse proxy rewriting `Host` or
 * `X-Forwarded-*` never changes what is verified. The scheme has no
 * timestamp; the idempotency window is the replay defence and the default
 * key is the signed body digest.
 */
export interface TwilioWebhookVerifierOptions {
  readonly id?: string;
}

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

export function twilioWebhookVerifier(options: TwilioWebhookVerifierOptions = {}): WebhookVerifier {
  return defineWebhookVerifier({
    id: options.id ?? "twilio",
    guarantees: { signature: true, freshness: false, replay: false },
    sensitiveHeaders: [TWILIO_SIGNATURE_HEADER],
    verify: async ({ headers, rawBody, canonicalUrl, secret }) => {
      const header = headers[TWILIO_SIGNATURE_HEADER];
      if (header === undefined) return { ok: false, reason: "missing-signature" };
      const presented = base64ToBytes(header);
      if (!presented || presented.byteLength !== 20) {
        return { ok: false, reason: "malformed-signature" };
      }
      let data: string;
      try {
        data = await signedData(canonicalUrl, headers["content-type"], rawBody);
      } catch {
        return { ok: false, reason: "unsupported-request" };
      }
      const expected = await hmac("SHA-1", secret, data);
      return constantTimeEqual(expected, presented)
        ? { ok: true }
        : { ok: false, reason: "signature-mismatch" };
    },
  });
}

/** Test helper: builds the `X-Twilio-Signature` value for a form or JSON delivery to `url`. */
export async function twilioSignatureHeader(input: {
  readonly authToken: string;
  readonly url: string;
  readonly rawBody: Uint8Array | string;
  readonly contentType?: string;
}): Promise<string> {
  const body = typeof input.rawBody === "string" ? utf8Bytes(input.rawBody) : input.rawBody;
  const data = await signedData(input.url, input.contentType ?? FORM_MEDIA_TYPE, body);
  return bytesToBase64(await hmac("SHA-1", input.authToken, data));
}

async function signedData(
  url: string,
  contentType: string | undefined,
  rawBody: Uint8Array,
): Promise<string> {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === FORM_MEDIA_TYPE) {
    const parameters = new Map<string, string[]>();
    for (const [key, value] of new URLSearchParams(utf8Text(rawBody))) {
      const values = parameters.get(key) ?? [];
      values.push(value);
      parameters.set(key, values);
    }
    let data = url;
    for (const key of [...parameters.keys()].sort()) {
      for (const value of [...(parameters.get(key) ?? [])].sort()) data += key + value;
    }
    return data;
  }
  const bodyDigest = bytesToHex(await digest("SHA-256", rawBody));
  return `${url}${url.includes("?") ? "&" : "?"}bodySHA256=${bodyDigest}`;
}
