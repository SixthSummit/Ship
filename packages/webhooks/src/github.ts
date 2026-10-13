import type { WebhookVerifier } from "@sixthsummit/ship-core";
import {
  bytesToHex,
  constantTimeEqual,
  defineWebhookVerifier,
  hexToBytes,
  hmac,
  utf8Bytes,
} from "@sixthsummit/ship-core";

/**
 * GitHub: `X-Hub-Signature-256: sha256=<hex>` where the hex is
 * HMAC-SHA256(secret, rawBody). The scheme carries no timestamp, so
 * freshness is not guaranteed and the idempotency window is the replay
 * defence. No event id is reported: `X-GitHub-Delivery` is not covered by
 * the signature, so the default key is the signed body digest. Declare an
 * explicit `idempotency.key` reading that header if per-delivery keys are
 * preferred over per-payload keys.
 */
export interface GithubWebhookVerifierOptions {
  readonly id?: string;
}

export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";

export function githubWebhookVerifier(options: GithubWebhookVerifierOptions = {}): WebhookVerifier {
  return defineWebhookVerifier({
    id: options.id ?? "github",
    guarantees: { signature: true, freshness: false, replay: false },
    sensitiveHeaders: [GITHUB_SIGNATURE_HEADER],
    verify: async ({ headers, rawBody, secret }) => {
      const header = headers[GITHUB_SIGNATURE_HEADER];
      if (header === undefined) return { ok: false, reason: "missing-signature" };
      if (!header.startsWith(PREFIX)) return { ok: false, reason: "malformed-signature" };
      const presented = hexToBytes(header.slice(PREFIX.length));
      if (!presented || presented.byteLength !== 32) {
        return { ok: false, reason: "malformed-signature" };
      }
      const expected = await hmac("SHA-256", secret, rawBody);
      return constantTimeEqual(expected, presented)
        ? { ok: true }
        : { ok: false, reason: "signature-mismatch" };
    },
  });
}

/** Test helper: builds the `X-Hub-Signature-256` value a real delivery would carry. */
export async function githubSignatureHeader(input: {
  readonly secret: string;
  readonly rawBody: Uint8Array | string;
}): Promise<string> {
  const body = typeof input.rawBody === "string" ? utf8Bytes(input.rawBody) : input.rawBody;
  return `${PREFIX}${bytesToHex(await hmac("SHA-256", input.secret, body))}`;
}
