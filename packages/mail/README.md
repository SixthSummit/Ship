# `@sixthsummit/ship-mail`

Declared transactional mail for Ship applications. `defineMailer` and the
`MailProvider` / `MailLedger` contracts are owned by `@sixthsummit/ship-core`;
this package owns delivery on the jobs capability, the typed sender an
operation receives, the non-production interceptor, development previews and
the provider adapters.

```ts
import { defineMailer, defineModule, mailLedgerDependency, mailProviderDependency, valueProvider } from "@sixthsummit/ship-core";
import { allowlistInterceptor, defineMailDelivery, defineMailPreview } from "@sixthsummit/ship-mail";
import { resendMailProvider } from "@sixthsummit/ship-mail/resend";
import { createDrizzleMailLedger, shipMailSendsTable } from "@sixthsummit/ship-drizzle";

export const accountsMailer = defineMailer({
  id: "accounts.mailer",
  from: "Accounts <accounts@example.com>",
  messages: {
    verifyEmail: {
      payload: z.object({ name: z.string(), url: z.string().url() }),
      sample: { name: "Ada", url: "https://app.example.com/verify/sample" },
      render: ({ name, url }) => ({
        subject: `Verify your email, ${name}`,
        html: `<p>Hi ${name}, <a href="${url}">verify your email</a>.</p>`,
        text: `Hi ${name}, verify your email: ${url}`,
      }),
    },
  },
});

const delivery = defineMailDelivery({
  mailers: [accountsMailer],
  interceptor: env.isProduction
    ? undefined
    : allowlistInterceptor({ allow: ["@example.com"], redirectTo: ["qa-inbox@example.com"] }),
});

// In an operation (transaction: "none"):
//   dependencies: { mail: delivery.dependency }
//   await services.mail.send(accountsMailer, "verifyEmail", {
//     to: account.email, payload: { name, url }, idempotencyKey: `verify:${account.id}:${token.id}`,
//   });

export const mailModule = defineModule({
  id: "mail",
  operations: [delivery.job, ...defineMailPreview({ mailers: [accountsMailer] }).operations],
  providers: [
    valueProvider(mailProviderDependency(), resendMailProvider({ apiKey: env.RESEND_API_KEY })),
    valueProvider(mailLedgerDependency(), createDrizzleMailLedger({ database })),
  ],
  imports: [],
  exports: [],
});
```

- A send is an enqueued run of `mail.deliver`: retry, backoff, dead-letter
  management and retention come from `defineJob` unchanged.
- The idempotency key deduplicates at enqueue while a run is live and is the
  ledger's primary key forever after; a replayed run answers `duplicate`
  without a second provider call.
- `shipMailSendsTable()` is the send ledger (`ship_mail_sends`). Include it in
  your migrations; query it with `ledger.list({ recipient })`.
- `allowlistInterceptor` redirects every non-allowlisted recipient and sets
  `X-Ship-Original-To`. Compose it only outside production.
- `defineMailPreview` adds `mail.preview-list` and `mail.preview-render`,
  gated by `ship.mail:preview`; attach HTTP transports from `ship-hono` where
  the preview belongs.
- The Resend adapter uses `fetch` and forwards the idempotency key as
  Resend's `Idempotency-Key` header. `logMailProvider` records sends in
  memory for tests and local development.

See `docs/v4/features/mail.md` in the repository for the full guide and
ADR-0023 for the decision record.
