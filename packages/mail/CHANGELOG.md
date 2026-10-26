# @sixthsummit/ship-mail

## 0.2.0

### Minor Changes

- b612767: Initial release of `@sixthsummit/ship-mail` (ADR-0023): `defineMailDelivery` compiles the `mail.deliver` job on the jobs capability and exposes a typed `MailSender` (`services.mail.send(mailer, "message", { to, payload, idempotencyKey })`) with enqueue deduplication and a ledger claim so a retried or replayed run never calls the provider twice for one key; `allowlistInterceptor` redirects non-production sends and records the original recipients in `X-Ship-Original-To`; `defineMailPreview` lists every mailer and renders each message from its sample; `logMailProvider` and `createInMemoryMailLedger` for tests and development; `@sixthsummit/ship-mail/resend` sends over `fetch` with Resend's `Idempotency-Key`; `@sixthsummit/ship-mail/conformance` proves providers and ledgers.

### Patch Changes

- 63eef39: Require `zod` `^4.6.7` (GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized constrained collections) and resolve `body-parser` to `2.4.0` under the MCP server's Express dependency (GHSA-27r3-jxmh-p828). No API change; the Angular library now runs its own suite against zod 4 and the Angular scaffold template asks for `zod ^4.6.7`.
