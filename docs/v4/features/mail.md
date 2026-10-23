# Transactional mail

Declared mailers with typed messages and pure HTML + text templates, delivered
through the jobs capability with a per-send idempotency key, a durable send
ledger, provider adapters, a non-production interceptor and a development
preview. Decision record: [ADR-0023](../../rearchitecture/decisions/0023-declared-transactional-mail.md).

| Package | Owns |
| --- | --- |
| `@sixthsummit/ship-core` | `defineMailer`, `renderMailMessage`, the `MailProvider` / `MailLedger` / `MailInterceptor` contracts, `mailProviderDependency()` / `mailLedgerDependency()`, graph projection |
| `@sixthsummit/ship-mail` | `defineMailDelivery` (the `mail.deliver` job and typed sender), `allowlistInterceptor`, `defineMailPreview`, `logMailProvider`, `createInMemoryMailLedger`, `@sixthsummit/ship-mail/resend`, `@sixthsummit/ship-mail/conformance` |
| `@sixthsummit/ship-drizzle` | `shipMailSendsTable()` and `createDrizzleMailLedger()` |
| `@sixthsummit/ship-contract` | projects mailer ids and message names (`contract.mailers`) |

## 1. Declare a mailer

```ts
// src/accounts/mail.ts
import { defineMailer } from "@sixthsummit/ship-core";
import { z } from "zod";

export const accountsMailer = defineMailer({
  id: "accounts.mailer", // namespaced by the module that declares it
  from: "Accounts <accounts@example.com>",
  replyTo: "support@example.com",
  messages: {
    verifyEmail: {
      payload: z.object({ name: z.string().min(1), url: z.string().url() }),
      description: "Sent after sign-up and on every re-request.",
      sample: { name: "Ada", url: "https://app.example.com/verify/sample" },
      render: ({ name, url }) => ({
        subject: `Verify your email, ${name}`,
        html: `<p>Hi ${name}, <a href="${url}">verify your email</a>.</p>`,
        text: `Hi ${name}, verify your email: ${url}`,
      }),
    },
  },
});
```

- `render` is a pure function of the validated payload and must return
  non-empty `subject`, `html` and `text`. It performs no I/O.
- `sample` feeds the development preview; it is validated against `payload`
  when rendered.
- Declare the mailer on its module: `defineModule({ id: "accounts", …,
  mailers: [accountsMailer] })`. A mailer id that does not start with the
  module id fails compilation (`SHIP_MAILER_ID_MISMATCH`), as does the same
  id declared twice (`SHIP_MAILER_ID_DUPLICATE`).

## 2. Compile delivery

```ts
// src/mail/module.ts
import { defineModule, mailLedgerDependency, mailProviderDependency, valueProvider } from "@sixthsummit/ship-core";
import { createDrizzleMailLedger } from "@sixthsummit/ship-drizzle";
import { allowlistInterceptor, defineMailDelivery, defineMailPreview } from "@sixthsummit/ship-mail";
import { resendMailProvider } from "@sixthsummit/ship-mail/resend";

export const delivery = defineMailDelivery({
  mailers: [accountsMailer],
  // from: "Ship <ship@example.com>",   // default for mailers that declare none
  interceptor: env.MAIL_ALLOWLIST
    ? allowlistInterceptor({ allow: env.MAIL_ALLOWLIST, redirectTo: [env.MAIL_QA_INBOX] })
    : undefined,
  retry: { attempts: 5, backoff: { initialMs: 2_000, multiplier: 4, maxMs: 15 * 60_000 } }, // default
});

export const mailModule = defineModule({
  id: "mail",
  operations: [delivery.job, ...defineMailPreview({ mailers: [accountsMailer] }).operations],
  providers: [
    valueProvider(mailProviderDependency(), resendMailProvider({ apiKey: env.RESEND_API_KEY })),
    valueProvider(mailLedgerDependency(), createDrizzleMailLedger({ database })),
  ],
  imports: ["platform"], // whichever module binds the job backend (`ship.jobs`)
  exports: [],
});
```

`delivery.job` is an ordinary `defineJob` result (`mail.deliver`, trigger
`enqueue`, `transaction: "none"`, the provider as its only effect). It needs
the job backend bound somewhere in the application and runs wherever
`startJobRuntime` starts workers. Dead letters are visible through
`defineJobManagement` and swept by `defineJobCleanup` like any other job.

Include the ledger table in your migrations:

```ts
// src/schema.ts
export const mailSends = shipMailSendsTable(); // ship_mail_sends
```

Generate the migration with your usual `drizzle-kit generate` step and apply it
as a gated release step. The table is only ever added to; the framework never
drops or retypes a column.

## 3. Send from an operation

```ts
const resendVerification = defineOperation({
  id: "accounts.resend-verification",
  transport: http.post("/accounts/:accountId/verification"),
  input: { params: accountParams },
  output: { 202: acceptedSchema },
  successStatus: 202,
  errors: [accountNotFound, mailQueueFull],
  access: permission("accounts:write"),
  transaction: "none",
  dependencies: { accounts: accountsRepository, mail: delivery.dependency },
  handler: async ({ input, services }) => {
    const account = await services.accounts.find(input.params.accountId);
    if (!account) throw operationFailure(accountNotFound);
    const token = await services.accounts.issueVerification(account.id);
    const sent = await services.mail.send(accountsMailer, "verifyEmail", {
      to: account.email,
      payload: { name: account.name, url: `${env.APP_URL}/verify/${token.id}` },
      idempotencyKey: `verify:${account.id}:${token.id}`,
      tenantId: account.tenantId,
    });
    if (!sent.accepted) throw operationFailure(mailQueueFull); // queue-full is a result, not an exception
    return { accepted: true, sendId: sent.sendId, deduplicated: sent.deduplicated };
  },
});
```

`services.mail` is a `MailSender` typed over the mailers registered with the
delivery: the message name and payload are checked by TypeScript, and at run
time the sender validates recipients, the idempotency key and the payload
before enqueueing (`MailSendError`, `MailRenderError`). A send is one enqueued
run with `dedupeKey = idempotencyKey`; while that run is live a repeated send
returns `deduplicated: true`.

Choose the idempotency key per logical send: `verify:${accountId}:${tokenId}`
means "this token's mail", `digest:${tenantId}:${period}:${recipient}` means
"this period's digest to this person". It is the ledger's primary key.

### Sending from a write transaction

`send` enqueues when it is called, not at commit. A `transaction: "write"`
operation that must not send if it rolls back records an outbox intent in the
transaction and sends from the dispatcher (see the durable outbox in
ADR-0014), which runs with `transaction: "none"`.

## 4. What the delivery job does

For every run of `mail.deliver`:

1. Look up the mailer and message; an unknown pair is the final failure
   `MAIL_MESSAGE_UNKNOWN`.
2. `renderMailMessage` validates the stored payload and runs the template; a
   payload that no longer satisfies the schema is the final failure
   `MAIL_PAYLOAD_INVALID`.
3. Apply the interceptor, if bound.
4. `ledger.claim(idempotencyKey)`:
   - new key: insert a `sending` row, continue;
   - already `sent`: return `{ status: "duplicate" }` without calling the
     provider;
   - `failed`, or a `sending` claim older than `claimLeaseMs` (5 min): retake it;
   - a live claim held by another run: fail retryably; the backend retries after
     backoff.
5. `provider.send(...)` exactly once per claim.
6. `markSent` (`{ status: "sent", providerMessageId }`), or `markFailed` and
   either retry (retryable outcome) or dead-letter with `MAIL_REJECTED` (final
   provider rejection).

Delivery is at-least-once at the job level, so the provider may be asked
twice for one key only if the process dies between step 5 and step 6; the
Resend adapter forwards the key as `Idempotency-Key`, which closes that window
on the provider side.

## 5. Non-production interception

```ts
allowlistInterceptor({
  allow: ["@example.com", "qa@partner.example"], // addresses or @domains
  redirectTo: ["qa-inbox@example.com"],
  subjectPrefix: true, // "[to: customer@real.example] Verify your email"
});
```

Every recipient outside the allowlist is replaced by the redirect inbox,
non-allowlisted `cc`/`bcc` are dropped, and `X-Ship-Original-To` carries the
original recipients (`cc:`/`bcc:` prefixed). The ledger row records `to`
(addressed), `deliveredTo` (actual) and `intercepted: true`, so proving the
staging fence is a query, not a screenshot. Bind the interceptor from your
validated configuration; the framework never reads `NODE_ENV`.

## 6. Development preview

`defineMailPreview({ mailers, prefix = "mail", access?, transport? })` adds:

- `mail.preview-list` → `{ mailers: [{ id, from?, messages: [{ name, description?, hasSample }] }] }`
- `mail.preview-render` with `params: { mailerId, message }` →
  `{ mailerId, message, subject, html, text, payload }` rendered from the
  message's `sample` (`MAIL_PREVIEW_NOT_FOUND`, `MAIL_PREVIEW_SAMPLE_MISSING`,
  `MAIL_PREVIEW_SAMPLE_INVALID`).

Both are gated by `ship.mail:preview` unless you pass another non-public
`access`. Attach transports where previews belong:

```ts
defineMailPreview({
  mailers,
  transport: { list: http.get("/dev/mail"), render: http.get("/dev/mail/:mailerId/:message") },
});
```

## 7. The send ledger

`ship_mail_sends` has one row per idempotency key:

| Column | Meaning |
| --- | --- |
| `idempotency_key` (PK) | the consumer's key |
| `mailer_id`, `message` | which message |
| `recipients` (jsonb, GIN) | addressed recipients |
| `delivered_to` (jsonb) | recipients the provider was asked to deliver to |
| `intercepted` | whether the non-production interceptor redirected the send |
| `subject`, `provider`, `provider_message_id` | what went out and the provider's id |
| `status` | `sending` → `sent` \| `failed` |
| `attempts`, `last_error` | claims so far and the last failure |
| `tenant_id` | from `send({ tenantId })` |
| `created_at`, `claimed_at`, `sent_at`, `failed_at` | timestamps |

Query it through the contract: `ledger.find(key)`, `ledger.list({ recipient,
mailerId?, message?, tenantId?, limit })`, `ledger.cleanup({ before })` for
retention (call it from a scheduled job).

## 8. Providers

- `logMailProvider({ sink?, outcome?, clock? })` records accepted sends
  (`provider.sent()`), forwards each to `sink`, and `outcome` lets a test
  simulate retryable failures and final rejections.
- `resendMailProvider({ apiKey, fetch?, baseUrl?, timeoutMs? })` (subpath
  `@sixthsummit/ship-mail/resend`) posts to `/emails` with the bearer key and
  `Idempotency-Key`. 429/5xx/timeouts/network errors are retryable; other 4xx
  are final. The key is never echoed in an outcome.
- Implement `MailProvider` for another service and run
  `mailProviderConformance(name, harness, { describe, it, beforeEach, afterEach, expect })`
  from `@sixthsummit/ship-mail/conformance`; `mailLedgerConformance` covers a
  custom ledger.

## 9. Testing

```ts
const provider = logMailProvider();
const ledger = createInMemoryMailLedger();
const jobs = createInMemoryJobBackend();
const app = createApplication({ provider, ledger, jobs });
await startJobRuntime(app, { backend: jobs, mode: "api" });

await createExecutor(app).run("accounts.resend-verification", input, { actor });
await jobs.drain();                               // runs mail.deliver through the executor
expect(provider.sent()).toHaveLength(1);
expect(ledger.records()[0]).toMatchObject({ status: "sent", attempts: 1 });
await runJobOnce(app, "mail.deliver", jobs.runs()[0].input); // replay → { status: "duplicate" }
```

The customized golden consumer (`fixtures/consumers/customized`) carries a
complete example: `reports.mailer`, the `reports.email` operation, the `mail`
module, the interceptor case and the PostgreSQL integration test that proves
one ledger row and one provider call across enqueue, drain and replay.

## Diagnostics and errors

| Code | Where | Meaning |
| --- | --- | --- |
| `SHIP_MAILER_*` | `defineMailer` | invalid id, from, replyTo, message name, payload schema, render or description |
| `SHIP_MODULE_MAILER_INVALID` / `_DUPLICATE` | `defineModule` | `mailers` entries |
| `SHIP_MAILER_ID_DUPLICATE` / `SHIP_MAILER_ID_MISMATCH` | compile | ownership and namespacing |
| `SHIP_MAIL_MESSAGE_UNKNOWN` / `SHIP_MAIL_PAYLOAD_INVALID` / `SHIP_MAIL_RENDERING_INVALID` | `renderMailMessage` | `MailRenderError` |
| `SHIP_MAIL_DELIVERY_OPTIONS_INVALID` | `defineMailDelivery` | options |
| `SHIP_MAIL_MAILER_UNREGISTERED` / `SHIP_MAIL_RECIPIENT_INVALID` / `SHIP_MAIL_IDEMPOTENCY_KEY_INVALID` | `sender.send` | `MailSendError` at the call site |
| `SHIP_MAIL_SEND_IN_FLIGHT` / `SHIP_MAIL_PROVIDER_FAILED` | `mail.deliver` | retryable run failures |
| `MAIL_MESSAGE_UNKNOWN` / `MAIL_PAYLOAD_INVALID` / `MAIL_REJECTED` | `mail.deliver` | declared final failures (dead-lettered) |
| `MAIL_PREVIEW_NOT_FOUND` / `MAIL_PREVIEW_SAMPLE_MISSING` / `MAIL_PREVIEW_SAMPLE_INVALID` | preview | declared failures |
| `SHIP_DRIZZLE_MAIL_LEDGER_INVALID` | `ship-drizzle` | ledger definition |
