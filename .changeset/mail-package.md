---
"@sixthsummit/ship-mail": minor
---

Initial release of `@sixthsummit/ship-mail` (ADR-0023): `defineMailDelivery` compiles the `mail.deliver` job on the jobs capability and exposes a typed `MailSender` (`services.mail.send(mailer, "message", { to, payload, idempotencyKey })`) with enqueue deduplication and a ledger claim so a retried or replayed run never calls the provider twice for one key; `allowlistInterceptor` redirects non-production sends and records the original recipients in `X-Ship-Original-To`; `defineMailPreview` lists every mailer and renders each message from its sample; `logMailProvider` and `createInMemoryMailLedger` for tests and development; `@sixthsummit/ship-mail/resend` sends over `fetch` with Resend's `Idempotency-Key`; `@sixthsummit/ship-mail/conformance` proves providers and ledgers.
