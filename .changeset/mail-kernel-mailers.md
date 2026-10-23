---
"@sixthsummit/ship-core": minor
---

Add declared transactional mail to the kernel (ADR-0023): `defineMailer` with typed messages, pure `render(payload) => { subject, html, text }` templates and samples; `defineModule({ mailers })` with graph projection (`graph.mailers`, module `mailers`) and the `SHIP_MAILER_ID_DUPLICATE` / `SHIP_MAILER_ID_MISMATCH` diagnostics; `renderMailMessage` / `validateMailPayload`; the `MailProvider`, `MailLedger`, `MailInterceptor` and `MailEnvelope` contracts with `mailProviderDependency()` / `mailLedgerDependency()`; and `adaptedJobDependency` so a job enqueue token can resolve to a typed facade while keeping its graph edge. `isOperationAccess` is now exported.
