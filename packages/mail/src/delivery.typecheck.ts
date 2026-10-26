/**
 * Type-level proof that composing mail into an application keeps every
 * operation id literal (a `string` job id would widen `operationById` into an
 * index signature and erase the client contract) and that the sender is typed
 * over the registered mailers and their payloads.
 */
import type { InferSchemaInput, OperationId } from "@sixthsummit/ship-core";
import { accountsMailer, billingMailer, createFixtureApplication } from "./__fixtures__/app.js";
import type { MailSender } from "./delivery.js";
import { defineMailDelivery } from "./delivery.js";
import { logMailProvider } from "./log.js";
import { createInMemoryMailLedger } from "./memory-ledger.js";
import { defineMailPreview } from "./preview.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const { app, delivery } = createFixtureApplication({
  provider: logMailProvider(),
  ledger: createInMemoryMailLedger(),
});

type Ids = Expect<
  Equal<
    OperationId<typeof app>,
    "accounts.send-welcome" | "mail.deliver" | "mail.preview-list" | "mail.preview-render"
  >
>;
type JobId = Expect<Equal<(typeof delivery)["job"]["id"], "mail.deliver">>;

const custom = defineMailDelivery({
  id: "notifications.deliver",
  mailers: [accountsMailer],
  from: "x@example.test",
});
type CustomId = Expect<Equal<(typeof custom)["job"]["id"], "notifications.deliver">>;
const preview = defineMailPreview({ mailers: [accountsMailer], prefix: "dev" });
type PreviewIds = Expect<
  Equal<(typeof preview)["operations"][number]["id"], "dev.preview-list" | "dev.preview-render">
>;
export const _ids: [Ids, JobId, CustomId, PreviewIds] = [true, true, true, true];

declare const sender: MailSender<readonly [typeof accountsMailer, typeof billingMailer]>;
type WelcomePayload = InferSchemaInput<(typeof accountsMailer)["messages"]["welcome"]["payload"]>;
export async function proofs(): Promise<void> {
  await sender.send(accountsMailer, "welcome", {
    to: "ada@example.test",
    payload: { name: "Ada", url: "https://example.test" } satisfies WelcomePayload,
    idempotencyKey: "welcome:ada",
  });
  await sender.send(billingMailer, "invoice", {
    to: ["a@example.test"],
    payload: { amount: 1, currency: "USD" },
    idempotencyKey: "invoice:1",
  });
  // @ts-expect-error the message name must belong to the mailer
  await sender.send(accountsMailer, "invoice", {
    to: "a@example.test",
    payload: {},
    idempotencyKey: "k",
  });
  await sender.send(accountsMailer, "welcome", {
    to: "a@example.test",
    // @ts-expect-error the payload must satisfy the message schema
    payload: { name: 1 },
    idempotencyKey: "k",
  });
}
