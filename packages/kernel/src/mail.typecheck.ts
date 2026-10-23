/**
 * Type-level proof for `defineMailer`: each message's `render` and `sample`
 * are contextually typed from that message's own payload schema, the mailer
 * is assignable to `AnyMailer` (so modules and delivery accept it) and message
 * names are literal.
 */
import type { AnyMailer, InferSchemaOutput, Mailer, RuntimeSchema } from "./index.js";
import { defineMailer, defineModule } from "./index.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function schema<TValue>(): RuntimeSchema<TValue, TValue> {
  return {
    "~standard": {
      version: 1,
      vendor: "typecheck",
      validate: (value: unknown) => ({ value: value as TValue }),
    },
  };
}

const welcomePayload = schema<{ readonly name: string; readonly url: string }>();
const invoicePayload = schema<{ readonly amount: number }>();

export const mailer = defineMailer({
  id: "accounts.mailer",
  from: "accounts@example.test",
  messages: {
    welcome: {
      payload: welcomePayload,
      sample: { name: "Ada", url: "https://example.test" },
      render: ({ name, url }) => {
        type Name = Expect<Equal<typeof name, string>>;
        type Url = Expect<Equal<typeof url, string>>;
        const _proof: [Name, Url] = [true, true];
        return { subject: name, html: url, text: url };
      },
    },
    invoice: {
      payload: invoicePayload,
      render: ({ amount }) => ({ subject: String(amount), html: "h", text: "t" }),
    },
  },
});

type Names = Expect<Equal<(typeof mailer)["messageNames"][number], "welcome" | "invoice">>;
type Welcome = Expect<
  Equal<
    InferSchemaOutput<(typeof mailer)["messages"]["welcome"]["payload"]>,
    { readonly name: string; readonly url: string }
  >
>;
export const _names: [Names, Welcome] = [true, true];

export const typedMailer: Mailer<
  "accounts.mailer",
  { welcome: typeof welcomePayload; invoice: typeof invoicePayload }
> = mailer;
export const erased: AnyMailer = mailer;

export const module_ = defineModule({
  id: "accounts",
  operations: [],
  providers: [],
  imports: [],
  exports: [],
  mailers: [mailer],
});

defineMailer({
  id: "accounts.bad",
  messages: {
    welcome: {
      payload: welcomePayload,
      // @ts-expect-error the sample must satisfy the payload schema input
      sample: { name: 1 },
      render: () => ({ subject: "s", html: "h", text: "t" }),
    },
  },
});
