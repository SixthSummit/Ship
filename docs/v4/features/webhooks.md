# Webhooks

> **Compatibility and migration guide:** `parseWebhook` remains supported. New
> operations model byte-exact bounded ingress and durable transactional handoff;

`parseWebhook` for receiving signed webhook payloads from Stripe, GitHub, Slack, and Twilio — plus the contract for adding adapters for other providers. HMAC verification, replay protection, and the body-reading semantics that make signature verification work.

## The pattern

Webhook receivers can't just `JSON.parse(c.req.json())` — the signature is computed over the raw body bytes, so the parser needs to verify *before* the bytes are interpreted. `parseWebhook` does both:

```ts
import { parseWebhook } from "@sixthsummit/ship-api";

app.post("/webhooks/stripe", async (c) => {
  const { payload } = await parseWebhook(c, {
    provider: "stripe",
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  // payload is the verified, parsed event
  if (payload.type === "charge.succeeded") {
    await handleChargeSucceeded(payload);
  }
  return c.json({ received: true });
});
```

If verification fails, `parseWebhook` throws `AuthenticationError` — which `registerErrorHandlers` turns into 401. The handler never runs.

## Signature

```ts
async function parseWebhook<T = unknown>(
  c: Context,
  opts: ParseWebhookOptions,
): Promise<ParseWebhookResult<T>>;

interface ParseWebhookOptions {
  provider: BuiltInProvider | WebhookVerifier;  // "stripe" | "github" | "slack" | custom
  secret: string;
  parse?: ((rawBody: string) => unknown) | false;  // default: JSON.parse; false skips parsing
}

interface ParseWebhookResult<T> {
  rawBody: string;   // verbatim bytes the signature was computed over
  payload: T;        // parsed payload (parse function output)
}
```

`parse: false` returns `payload: undefined` — useful when the body isn't JSON (Slack's interactive payloads are URL-encoded; provide a custom parser).

## Built-in adapters

| Provider | Signature header | Algorithm | Replay window |
| --- | --- | --- | --- |
| **Stripe** | `Stripe-Signature: t=<ts>,v1=<hex>[,v0=<hex>]` | HMAC-SHA256 over `<ts>.<body>` | 5 minutes (300s) |
| **GitHub** | `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 over body | None (GitHub doesn't include timestamp) |
| **Slack** | `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp` | HMAC-SHA256 over `v0:<ts>:<body>` | 5 minutes |
| **Twilio** | `X-Twilio-Signature: <base64>` | HMAC-SHA1 over URL + sorted params | None |

All adapters use Node's `crypto.createHmac` + `timingSafeEqual` for constant-time comparison — no oracle leakage on length or content mismatch.

### Stripe

Stripe sends the timestamp inline with the signature so each event includes its own timestamp. The adapter:

1. Parses `Stripe-Signature` for the timestamp (`t=`) and signatures (`v1=`, optionally `v0=` during key rotation).
2. Validates timestamp is within 5 minutes of `now()` (or whatever `now` you inject for tests). Rejects on skew.
3. Computes `HMAC-SHA256(<ts>.<rawBody>)` using each presented signature value's expected key. Accepts if any match — supports key rotation by adding a second key during transition.

### GitHub

`X-Hub-Signature-256: sha256=<hex>` — verify the body matches the secret. No timestamp, so no replay protection at this layer. GitHub's webhooks include a delivery id (`X-GitHub-Delivery`); use it to dedupe replays at the application level (track delivery ids you've already processed in your idempotency cache or a `webhook_deliveries` table).

### Slack

Slack signs `v0:<ts>:<body>` with the timestamp explicitly part of the signed payload — replay attempts with a stale timestamp produce a verification failure. The adapter rejects timestamps more than 5 minutes off.

### Twilio

Twilio signs the **full URL plus sorted form params** — different shape from Stripe / GitHub. The adapter computes the signature against the request URL and form-decoded body; if your app is behind a proxy that rewrites paths, set the `X-Forwarded-Proto` and `X-Forwarded-Host` headers correctly so the URL matches what Twilio signed.

## Custom adapters

The `WebhookVerifier` interface:

```ts
interface WebhookVerifier {
  readonly name: string;
  verify(args: WebhookVerifyArgs): WebhookVerifyResult;
}

interface WebhookVerifyArgs {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
  secret: string;
  now?: number;                      // injected for deterministic tests
}

type WebhookVerifyResult = { ok: true } | { ok: false; reason: string };
```

A custom adapter for an in-house webhook source:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookVerifier } from "@sixthsummit/ship-api";

const internalProvider: WebhookVerifier = {
  name: "internal",
  verify({ rawBody, headers, secret }) {
    const presented = headers["x-internal-signature"];
    if (!presented) return { ok: false, reason: "Missing X-Internal-Signature" };
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(presented, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: "Signature mismatch" };
    }
    return { ok: true };
  },
};

app.post("/webhooks/internal", async (c) => {
  const { payload } = await parseWebhook(c, {
    provider: internalProvider,
    secret: env.INTERNAL_WEBHOOK_SECRET,
  });
  await processInternalEvent(payload);
  return c.json({ ok: true });
});
```

The `name` field is for logging — the framework includes it in error logs when verification fails. Use a stable name per provider.

## Body reading

Hono caches the request body the first time you read it (via `c.req.text()`, `c.req.json()`, etc.). `parseWebhook` calls `c.req.text()` to get the raw bytes for HMAC, then `JSON.parse` (or your custom `parse`) to produce the payload.

This means: **don't call `c.req.json()` before `parseWebhook`.** The first read parses the body, and the raw bytes you'd need for HMAC verification become unrecoverable. If you have middleware that reads the body for logging or rate-limit-key generation, make sure it doesn't run before `parseWebhook`.

The reverse is fine: after `parseWebhook` returns, you have `rawBody` (string) and `payload` (parsed) — both are available, no further reads needed.

## Replay protection at the application level

Built-in adapters with timestamp validation (Stripe, Slack) protect against replays older than 5 minutes. For shorter windows (or providers without timestamps), dedupe at the application:

```ts
app.post("/webhooks/github", async (c) => {
  const { payload } = await parseWebhook(c, { provider: "github", secret: env.GH_SECRET });
  const deliveryId = c.req.header("x-github-delivery");

  // Have we seen this delivery id?
  const claimed = await cache.setIfAbsent(`gh-delivery:${deliveryId}`, "1", { ttlSec: 7 * 24 * 60 * 60 });
  if (!claimed) return c.json({ duplicate: true }, 200);  // already processed

  await handleGithubEvent(payload);
  return c.json({ received: true });
});
```

The framework's [idempotency middleware](idempotency.md) wraps this pattern when the provider includes a key the middleware can use; for cases where the dedupe identifier is provider-specific (delivery id), do it inline.

## Testing

Unit-test handlers by injecting a custom adapter that always succeeds:

```ts
const passThrough: WebhookVerifier = {
  name: "test",
  verify: () => ({ ok: true }),
};

it("processes charge.succeeded", async () => {
  const c = mockContext({ method: "POST", body: JSON.stringify({ type: "charge.succeeded" }) });
  const { payload } = await parseWebhook(c, { provider: passThrough, secret: "unused" });
  // assert handler behavior
});
```

For integration tests against the real verifier, generate signatures inline using the same algorithm:

```ts
// Stripe-style signature:
const ts = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
const header = `t=${ts},v1=${sig}`;
```

Inject `now` into `parseWebhook` (via an internal test hook) for deterministic timestamp tests.

## Operational concerns

**Webhooks need fast acknowledgment.** Most providers retry on non-2xx responses; some have aggressive retry policies (Stripe retries for 3 days with exponential backoff). Acknowledge fast (synchronous handler returns 200), do the actual work asynchronously via the [outbox pattern](jobs.md#the-outbox-pattern--atomic-enqueue-with-database-writes) if it's slow.

**Signature secrets are real secrets.** Rotate them periodically. Stripe supports key rotation natively (multiple `v0`/`v1` signatures during transition); for providers that don't, time the rotation with a maintenance window.

**Log verification failures.** A spike in failed verifications usually means a misconfigured client or a key rotation that didn't fully roll out. The framework logs failures at warn level with the provider name and reason — set up an alert on rate.

**Don't accept arbitrary types.** The payload is parsed JSON from a third party; treat it as untrusted. Validate the parsed payload through a Zod schema before consuming:

```ts
const stripeChargeSucceededSchema = z.object({
  type: z.literal("charge.succeeded"),
  data: z.object({ object: z.object({ id: z.string(), amount: z.number() }) }),
});

const { payload } = await parseWebhook(c, { provider: "stripe", secret });
const parsed = stripeChargeSucceededSchema.parse(payload);  // throws on shape mismatch
```

Webhook signatures verify the source; payload validation verifies the shape. Both matter.

## Source

- [`packages/core/src/http/utils/webhooks.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/utils/webhooks.ts) — `parseWebhook`, built-in verifiers, `WebhookVerifier` interface
