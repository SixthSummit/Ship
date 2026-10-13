import type { WebhookVerifier } from "@sixthsummit/ship-core";
import { constantTimeEqual, defineWebhookVerifier, utf8Bytes } from "@sixthsummit/ship-core";

/**
 * A dedicated, rotatable shared secret carried in one request header and
 * compared in constant time. Provided for providers that offer nothing
 * stronger.
 *
 * Guarantees are all `false`: the body is not authenticated (an attacker who
 * observes the header can send any body), there is no freshness bound, and
 * replays are limited only by the webhook's idempotency window. Use it only
 * over HTTPS with a secret dedicated to this webhook, prefer an HMAC scheme
 * where the provider offers one, and treat IP allowlisting as an optional
 * supplementary control at the network edge. The header is registered as
 * sensitive so it is never persisted with a stored event.
 */
export interface SharedSecretWebhookVerifierOptions {
  /** Lower-cased header name; defaults to `x-webhook-secret`. */
  readonly header?: string;
  /** `bearer` expects `Bearer <secret>`; `raw` (default) expects the bare secret. */
  readonly scheme?: "raw" | "bearer";
  readonly id?: string;
}

export function sharedSecretWebhookVerifier(
  options: SharedSecretWebhookVerifierOptions = {},
): WebhookVerifier {
  const header = (options.header ?? "x-webhook-secret").toLowerCase();
  const scheme = options.scheme ?? "raw";
  return defineWebhookVerifier({
    id: options.id ?? "shared-secret",
    guarantees: { signature: false, freshness: false, replay: false },
    sensitiveHeaders: [header],
    verify: ({ headers, secret }) => {
      const presented = headers[header];
      if (presented === undefined) return { ok: false, reason: "missing-signature" };
      let token = presented;
      if (scheme === "bearer") {
        const match = /^Bearer (.+)$/u.exec(presented);
        if (!match?.[1]) return { ok: false, reason: "malformed-signature" };
        token = match[1];
      }
      return constantTimeEqual(utf8Bytes(token), utf8Bytes(secret))
        ? { ok: true }
        : { ok: false, reason: "signature-mismatch" };
    },
  });
}

/** Test helper: the header a provider configured with this secret would send. */
export function sharedSecretHeader(
  secret: string,
  options: Pick<SharedSecretWebhookVerifierOptions, "header" | "scheme"> = {},
): Readonly<Record<string, string>> {
  const header = (options.header ?? "x-webhook-secret").toLowerCase();
  return Object.freeze({ [header]: options.scheme === "bearer" ? `Bearer ${secret}` : secret });
}
