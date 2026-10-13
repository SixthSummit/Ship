# `@sixthsummit/ship-webhooks`

Optional provider verifiers for inbound webhook operations declared with
`defineWebhook` from `@sixthsummit/ship-core`. The verifier contract, the
bounded raw-body transport, provider actors, idempotency and durable receipt
are framework-owned; this package only knows provider signature protocols.

Each provider is an independent subpath so an application loads only what it
binds. The root entry imports no provider.

| Subpath | Scheme | Guarantees (signature / freshness / replay) | Event id |
| --- | --- | --- | --- |
| `./stripe` | `Stripe-Signature` t/v1 HMAC-SHA256 with tolerance | yes / yes / no | signed body `id` |
| `./github` | `X-Hub-Signature-256` HMAC-SHA256 | yes / no / no | none (body digest) |
| `./slack` | `X-Slack-Signature` v0 HMAC-SHA256 + request timestamp | yes / yes / no | signed `event_id` |
| `./twilio` | `X-Twilio-Signature` HMAC-SHA1 over canonical URL + sorted form params (or `bodySHA256`) | yes / no / no | none (body digest) |
| `./resend` | Svix `svix-id`/`svix-timestamp`/`svix-signature` HMAC-SHA256, multi-signature | yes / yes / no | signed `svix-id` |
| `./ghl` | HighLevel `X-GHL-Signature` Ed25519 (or legacy `X-WH-Signature` RSA-SHA256) over the raw body with a PEM public key | yes / no / no | none (body digest) |
| `./shared-secret` | constant-time compare of a dedicated header | no / no / no | none (body digest) |

`replay` is `false` everywhere: replay protection is the webhook's declared
idempotency window, keyed by the signed event id where the scheme provides one
and by the raw-body SHA-256 otherwise.

```ts
import { defineWebhook, webhookSecret, webhookVerifierToken } from "@sixthsummit/ship-core";
import { stripeWebhookVerifier } from "@sixthsummit/ship-webhooks/stripe";

const stripe = defineWebhook({
  id: "payments.stripe-webhook",
  path: "/webhooks/stripe",
  provider: webhookVerifierToken({
    verifier: stripeWebhookVerifier(),
    secret: webhookSecret(env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS),
  }),
  body: { maxBytes: 262_144, mediaTypes: ["application/json"] },
  idempotency: { windowMs: 3 * 86_400_000, store, inFlight: { kind: "retry", status: 409 } },
  retention: { eventsMs: 30 * 86_400_000, claimsMs: 7 * 86_400_000 },
  receive: { mode: "enqueue", outbox, intent: "process-webhook", store: events, unitOfWork },
});
```

## Notes per provider

- **Twilio** signs the exact public URL it was configured with. The framework
  hands the verifier the canonical URL derived from
  `createHonoAdapter({ webhooks: { publicBaseUrl } })` plus the operation path,
  so `Host` and `X-Forwarded-*` rewrites by a proxy are inert. The secret is
  the account auth token. Twilio executes the acknowledgement: declare
  `response: { mode: "text", contentType: "text/xml" }` and return TwiML from
  the handler for voice and messaging webhooks, and `response: { mode: "empty" }`
  for status callbacks that expect a bodiless `200`.
- **HighLevel** uses public-key signatures, so the "secret" is HighLevel's
  published PEM public key. The verifier embeds no key; copy the current key
  from the HighLevel marketplace webhook documentation into configuration and
  rotate it through the same `WebhookSecretSource` as any secret. Choose
  `ghlWebhookVerifier({ algorithm: "rsa-sha256" })` only while the legacy
  header is still sent.
- **Shared secret** authenticates the caller, not the body: any body sent
  with a leaked header verifies, and nothing bounds request age. Use it only
  over HTTPS with a secret dedicated to one webhook, prefer an HMAC scheme
  wherever the provider offers one, and treat IP allowlisting as an optional
  supplementary edge control. The header is registered as sensitive and is
  never persisted with a stored event.
- **GitHub** does not sign `X-GitHub-Delivery`; the verifier reports no event
  id so the default key is the signed body digest. Declare an explicit
  `idempotency.key` reading that header if per-delivery keys are preferred.

Every verifier registers its signature header(s) as sensitive, so stored
events keep the exact body but never the signature or a shared secret.

Every verifier ships a test-only signing helper (`stripeSignatureHeader`,
`githubSignatureHeader`, `slackSignatureHeaders`, `twilioSignatureHeader`,
`resendSignatureHeaders`, `ghlSignatureHeader`, `sharedSecretHeader`) so
application tests can produce real deliveries with known secrets.
