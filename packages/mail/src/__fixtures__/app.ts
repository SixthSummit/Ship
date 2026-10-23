import type { MailInterceptor, MailLedger, MailProvider } from "@sixthsummit/ship-core";
import {
  defineApp,
  defineMailer,
  defineModule,
  defineOperation,
  jobBackendDependency,
  jsonValueSchema,
  mailLedgerDependency,
  mailProviderDependency,
  objectSchema,
  optionalSchema,
  permission,
  stringSchema,
  valueProvider,
} from "@sixthsummit/ship-core";
import { createInMemoryJobBackend } from "@sixthsummit/ship-testing/jobs";
import { z } from "zod";
import { defineMailDelivery, type MailDeliveryOptions } from "../delivery.js";
import { defineMailPreview } from "../preview.js";

export const accountsMailer = defineMailer({
  id: "accounts.mailer",
  from: "Accounts <accounts@example.test>",
  replyTo: "support@example.test",
  messages: {
    welcome: {
      payload: z.object({ name: z.string().min(1), url: z.string().url() }),
      description: "Sent once after sign-up.",
      sample: { name: "Ada", url: "https://example.test/verify/sample" },
      render: ({ name, url }) => ({
        subject: `Welcome, ${name}`,
        html: `<p>Welcome, ${name}. <a href="${url}">Verify</a></p>`,
        text: `Welcome, ${name}. Verify: ${url}`,
      }),
    },
    passwordReset: {
      payload: z.object({ url: z.string().url() }),
      render: ({ url }) => ({
        subject: "Reset your password",
        html: `<a href="${url}">Reset</a>`,
        text: `Reset: ${url}`,
      }),
    },
  },
});

export const billingMailer = defineMailer({
  id: "billing.mailer",
  messages: {
    invoice: {
      payload: z.object({ amount: z.number().int(), currency: z.string().length(3) }),
      sample: { amount: 1250, currency: "USD" },
      render: ({ amount, currency }) => ({
        subject: `Invoice ${amount} ${currency}`,
        html: `<p>${amount} ${currency}</p>`,
        text: `${amount} ${currency}`,
      }),
    },
  },
});

export const sendBodySchema = objectSchema({
  to: stringSchema({ minLength: 3 }),
  name: stringSchema({ minLength: 1 }),
  key: stringSchema({ minLength: 1 }),
  tenantId: optionalSchema(stringSchema({ minLength: 1 })),
});

export interface FixtureOptions {
  readonly provider: MailProvider;
  readonly ledger: MailLedger;
  readonly interceptor?: MailInterceptor;
  readonly delivery?: Partial<
    MailDeliveryOptions<readonly [typeof accountsMailer, typeof billingMailer]>
  >;
  readonly jobs?: ReturnType<typeof createInMemoryJobBackend>;
}

/** A two-module application: `accounts` sends, `mail` delivers and previews. */
export function createFixtureApplication(options: FixtureOptions) {
  const jobs = options.jobs ?? createInMemoryJobBackend();
  const delivery = defineMailDelivery({
    mailers: [accountsMailer, billingMailer],
    from: "Ship <ship@example.test>",
    ...(options.interceptor ? { interceptor: options.interceptor } : {}),
    ...options.delivery,
  });
  const preview = defineMailPreview({ mailers: delivery.mailers });
  const sendWelcome = defineOperation({
    id: "accounts.send-welcome",
    input: { body: sendBodySchema },
    output: { 200: jsonValueSchema() },
    successStatus: 200,
    errors: [],
    access: permission("accounts:write"),
    transaction: "none",
    dependencies: { mail: delivery.dependency },
    handler: ({ input, services }) =>
      services.mail.send(accountsMailer, "welcome", {
        to: input.body.to,
        payload: { name: input.body.name, url: "https://example.test/verify/abc" },
        idempotencyKey: input.body.key,
        ...(input.body.tenantId !== undefined ? { tenantId: input.body.tenantId } : {}),
      }),
  });
  const accounts = defineModule({
    id: "accounts",
    operations: [sendWelcome],
    providers: [],
    imports: ["mail"],
    exports: [],
    mailers: [accountsMailer],
  });
  const billing = defineModule({
    id: "billing",
    operations: [],
    providers: [],
    imports: [],
    exports: [],
    mailers: [billingMailer],
  });
  const mail = defineModule({
    id: "mail",
    operations: [delivery.job, ...preview.operations],
    providers: [
      valueProvider(jobBackendDependency(), jobs),
      valueProvider(mailProviderDependency(), options.provider),
      valueProvider(mailLedgerDependency(), options.ledger),
    ],
    imports: [],
    exports: [jobBackendDependency()],
  });
  const app = defineApp({ id: "mail-fixture", modules: [accounts, billing, mail] });
  return { app, jobs, delivery, preview };
}
