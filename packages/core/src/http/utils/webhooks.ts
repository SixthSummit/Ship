import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { AuthenticationError } from "../errors/AuthenticationError.js";
import { BadRequestError } from "../errors/BadRequestError.js";

/**
 * `parseWebhook(c, { provider, secret })` — verify a webhook signature and
 * return the parsed payload + raw body.
 *
 * Replaces ad-hoc Express `express.raw()` patterns. Reads
 * `await c.req.text()` to preserve the *exact* bytes the sender signed —
 * Hono caches the body so subsequent calls work too.
 *
 * Built-in providers: `stripe`, `github`, `slack`. For others, pass a
 * custom `WebhookVerifier`. Twilio's URL+form-fields scheme requires the
 * full request URL plus form-encoding context; out-of-scope for v4.0 — a
 * v4.x adapter lands when first needed.
 *
 * Replay protection (where the provider exposes a timestamp): rejects
 * requests where the timestamp is more than ~5 minutes off from now.
 *
 * On signature mismatch, throws `AuthenticationError` (mapped by
 * `registerErrorHandlers` to 401).
 */

export interface WebhookVerifyArgs {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  secret: string;
  /** Current epoch ms; injected for deterministic tests. */
  now?: number;
}

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: string };

export interface WebhookVerifier {
  readonly name: string;
  verify(args: WebhookVerifyArgs): WebhookVerifyResult;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length || aBuf.length === 0) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

// ─────────────────────────────────────────────────────────────────────────
// Stripe — `Stripe-Signature: t=<ts>,v1=<sig>[,v0=<sig>]`
//   sig = HMAC-SHA256(<ts>.<rawBody>) using endpoint secret
// ─────────────────────────────────────────────────────────────────────────

export const stripeVerifier: WebhookVerifier = {
  name: "stripe",
  verify({ rawBody, headers, secret, now = Date.now() }) {
    const sigHeader = headers["stripe-signature"];
    if (!sigHeader) return { ok: false, reason: "Missing Stripe-Signature header" };

    const parts = Object.fromEntries(
      sigHeader.split(",").map((p) => {
        const [k, v] = p.split("=");
        return [k?.trim(), v?.trim()];
      }),
    );
    const ts = parts.t;
    const v1 = parts.v1;
    if (!ts || !v1) return { ok: false, reason: "Stripe signature missing t / v1" };

    const tsMs = Number.parseInt(ts, 10) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: "Stripe signature timestamp outside tolerance" };
    }

    const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");

    if (!safeEqualHex(expected, v1)) {
      return { ok: false, reason: "Stripe signature mismatch" };
    }
    return { ok: true };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// GitHub — `X-Hub-Signature-256: sha256=<hex>`
//   sig = HMAC-SHA256(rawBody) using webhook secret
// ─────────────────────────────────────────────────────────────────────────

export const githubVerifier: WebhookVerifier = {
  name: "github",
  verify({ rawBody, headers, secret }) {
    const header = headers["x-hub-signature-256"];
    if (!header) return { ok: false, reason: "Missing X-Hub-Signature-256 header" };
    if (!header.startsWith("sha256=")) {
      return { ok: false, reason: "X-Hub-Signature-256 not in 'sha256=<hex>' form" };
    }
    const presented = header.slice("sha256=".length);
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!safeEqualHex(expected, presented)) {
      return { ok: false, reason: "GitHub signature mismatch" };
    }
    return { ok: true };
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Slack — `X-Slack-Signature: v0=<hex>`, `X-Slack-Request-Timestamp: <ts>`
//   sig = HMAC-SHA256(`v0:${ts}:${rawBody}`) using signing secret
// ─────────────────────────────────────────────────────────────────────────

export const slackVerifier: WebhookVerifier = {
  name: "slack",
  verify({ rawBody, headers, secret, now = Date.now() }) {
    const sig = headers["x-slack-signature"];
    const ts = headers["x-slack-request-timestamp"];
    if (!sig) return { ok: false, reason: "Missing X-Slack-Signature header" };
    if (!ts) return { ok: false, reason: "Missing X-Slack-Request-Timestamp header" };
    if (!sig.startsWith("v0=")) {
      return { ok: false, reason: "X-Slack-Signature not in 'v0=<hex>' form" };
    }

    const tsMs = Number.parseInt(ts, 10) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > REPLAY_WINDOW_MS) {
      return { ok: false, reason: "Slack signature timestamp outside tolerance" };
    }

    const presented = sig.slice("v0=".length);
    const expected = createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");

    if (!safeEqualHex(expected, presented)) {
      return { ok: false, reason: "Slack signature mismatch" };
    }
    return { ok: true };
  },
};

const BUILT_IN_VERIFIERS: Record<string, WebhookVerifier> = {
  stripe: stripeVerifier,
  github: githubVerifier,
  slack: slackVerifier,
};

export type BuiltInProvider = keyof typeof BUILT_IN_VERIFIERS;

export interface ParseWebhookOptions {
  /** Built-in provider name OR a custom WebhookVerifier. */
  provider: BuiltInProvider | WebhookVerifier;
  secret: string;
  /**
   * Parse the verified body. Default `JSON.parse`. Returns the raw text
   * unparsed if `parse: false`.
   */
  parse?: ((rawBody: string) => unknown) | false;
}

export interface ParseWebhookResult<T = unknown> {
  rawBody: string;
  payload: T;
}

/**
 * Verify the webhook signature, then return raw body + parsed payload.
 * Throws `AuthenticationError` on signature mismatch.
 */
export async function parseWebhook<T = unknown>(
  c: Context,
  opts: ParseWebhookOptions,
): Promise<ParseWebhookResult<T>> {
  const verifier =
    typeof opts.provider === "string" ? BUILT_IN_VERIFIERS[opts.provider] : opts.provider;
  if (!verifier) {
    throw new Error(`parseWebhook: unknown provider "${opts.provider as string}"`);
  }

  const rawBody = await c.req.text();
  const headers: Record<string, string | undefined> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = verifier.verify({ rawBody, headers, secret: opts.secret });
  if (!result.ok) {
    throw new AuthenticationError(`Webhook signature invalid: ${result.reason}`);
  }

  // F18: catch parse failures *after* the signature passes so a
  // bad body surfaces as 400 (BadRequestError) rather than the
  // unhandled 500 that would otherwise leak via the framework
  // error pipeline. There's no oracle here — the signature still
  // had to verify for control to reach this point.
  const parser = opts.parse === false ? null : (opts.parse ?? JSON.parse);
  if (!parser) {
    return { rawBody, payload: rawBody as unknown as T };
  }
  let payload: T;
  try {
    payload = parser(rawBody) as T;
  } catch (err) {
    throw new BadRequestError(
      `Webhook payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { rawBody, payload };
}
