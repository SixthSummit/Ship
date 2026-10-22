import type { AnyMailer, OperationAccess, OperationTransport } from "@sixthsummit/ship-core";
import {
  arraySchema,
  booleanSchema,
  defineOperation,
  isMailer,
  isOperationAccess,
  jsonValueSchema,
  MailRenderError,
  objectSchema,
  operationError,
  operationFailure,
  optionalSchema,
  permission,
  renderMailMessage,
  stringSchema,
} from "@sixthsummit/ship-core";

/** Permission that gates the preview operations unless `access` overrides it. */
export const MAIL_PREVIEW_PERMISSION = "ship.mail:preview";

const PREFIX_PATTERN = /^[a-z][a-z0-9-]*$/u;

const messageSummarySchema = objectSchema({
  name: stringSchema({ minLength: 1 }),
  description: optionalSchema(stringSchema()),
  hasSample: booleanSchema(),
});
const mailerSummarySchema = objectSchema({
  id: stringSchema({ minLength: 1 }),
  from: optionalSchema(stringSchema()),
  messages: arraySchema(messageSummarySchema),
});
const listOutputSchema = objectSchema({ mailers: arraySchema(mailerSummarySchema) });
const renderParamsSchema = objectSchema({
  mailerId: stringSchema({ minLength: 1 }),
  message: stringSchema({ minLength: 1 }),
});
const renderOutputSchema = objectSchema({
  mailerId: stringSchema({ minLength: 1 }),
  message: stringSchema({ minLength: 1 }),
  subject: stringSchema({ minLength: 1 }),
  html: stringSchema({ minLength: 1 }),
  text: stringSchema({ minLength: 1 }),
  payload: jsonValueSchema(),
});

export const mailPreviewNotFound = operationError({
  code: "MAIL_PREVIEW_NOT_FOUND",
  status: 404,
  message: "No such mailer message",
});

export const mailPreviewSampleMissing = operationError({
  code: "MAIL_PREVIEW_SAMPLE_MISSING",
  status: 409,
  message: "The message declares no sample payload",
  details: objectSchema({ mailerId: stringSchema(), message: stringSchema() }),
});

export const mailPreviewSampleInvalid = operationError({
  code: "MAIL_PREVIEW_SAMPLE_INVALID",
  status: 422,
  message: "The message sample does not satisfy its payload schema",
  details: objectSchema({ mailerId: stringSchema(), message: stringSchema() }),
});

export interface MailPreviewOptions<TPrefix extends string = "mail"> {
  readonly mailers: readonly AnyMailer[];
  /** Operation id prefix and owning module id. Defaults to `mail`. */
  readonly prefix?: TPrefix;
  /** Defaults to `permission("ship.mail:preview")`; previews are never public. */
  readonly access?: OperationAccess;
  /** Transport declarations supplied by the adapter in use (for example `http.get(...)`). */
  readonly transport?: {
    readonly list?: OperationTransport;
    readonly render?: OperationTransport;
  };
}

export class MailPreviewError extends Error {
  readonly code = "SHIP_MAIL_PREVIEW_OPTIONS_INVALID";
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "MailPreviewError";
    this.field = field;
  }
}

/**
 * Development preview: `<prefix>.preview-list` enumerates every registered
 * mailer and message, `<prefix>.preview-render` renders one message with its
 * declared sample through the same `renderMailMessage` production uses.
 * Compose it only where previews belong (never in production builds).
 */
export function defineMailPreview<const TPrefix extends string = "mail">(
  options: MailPreviewOptions<TPrefix>,
) {
  assertOptions(options);
  const prefix = (options.prefix ?? "mail") as TPrefix;
  const access = options.access ?? permission(MAIL_PREVIEW_PERMISSION);
  const mailers = [...options.mailers].sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(mailers.map((mailer) => [mailer.id, mailer]));

  const list = defineOperation({
    id: `${prefix}.preview-list` as const,
    ...(options.transport?.list ? { transport: options.transport.list } : {}),
    input: {},
    output: { 200: listOutputSchema },
    successStatus: 200,
    errors: [],
    access,
    transaction: "none",
    dependencies: {},
    handler: () => ({
      mailers: mailers.map((mailer) => ({
        id: mailer.id,
        ...(mailer.from !== undefined ? { from: mailer.from } : {}),
        messages: mailer.messageNames.map((name) => {
          const message = mailer.messages[name];
          return {
            name,
            ...(message?.description !== undefined ? { description: message.description } : {}),
            hasSample: message?.sample !== undefined,
          };
        }),
      })),
    }),
  });

  const render = defineOperation({
    id: `${prefix}.preview-render` as const,
    ...(options.transport?.render ? { transport: options.transport.render } : {}),
    input: { params: renderParamsSchema },
    output: { 200: renderOutputSchema },
    successStatus: 200,
    errors: [mailPreviewNotFound, mailPreviewSampleMissing, mailPreviewSampleInvalid],
    access,
    transaction: "none",
    dependencies: {},
    handler: async ({ input }) => {
      const mailer = byId.get(input.params.mailerId);
      const message = mailer?.messages[input.params.message];
      if (!mailer || !message) throw operationFailure(mailPreviewNotFound);
      if (message.sample === undefined) {
        throw operationFailure(mailPreviewSampleMissing, {
          details: { mailerId: mailer.id, message: input.params.message },
        });
      }
      try {
        const rendered = await renderMailMessage(mailer, input.params.message, message.sample);
        return {
          mailerId: rendered.mailerId,
          message: rendered.message,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          payload: rendered.payload,
        };
      } catch (error) {
        if (error instanceof MailRenderError && error.code === "SHIP_MAIL_PAYLOAD_INVALID") {
          throw operationFailure(mailPreviewSampleInvalid, {
            details: { mailerId: mailer.id, message: input.params.message },
            cause: error,
          });
        }
        throw error;
      }
    },
  });

  return Object.freeze({
    kind: "ship.mail-preview" as const,
    list,
    render,
    /** Both operations, ready to spread into a module's operations. */
    operations: Object.freeze([list, render] as const),
  });
}

export type MailPreview<TPrefix extends string = "mail"> = ReturnType<
  typeof defineMailPreview<TPrefix>
>;

function assertOptions(options: unknown): asserts options is MailPreviewOptions {
  if (typeof options !== "object" || options === null) {
    throw new MailPreviewError("mail preview options must be an object", "options");
  }
  const mailers = Reflect.get(options, "mailers");
  if (!Array.isArray(mailers) || !mailers.every((item) => isMailer(item))) {
    throw new MailPreviewError(
      "mail preview mailers must contain only defineMailer() results",
      "mailers",
    );
  }
  const prefix = Reflect.get(options, "prefix");
  if (prefix !== undefined && (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix))) {
    throw new MailPreviewError(
      "mail preview prefix must be a lowercase single-segment module id",
      "prefix",
    );
  }
  const access = Reflect.get(options, "access");
  if (access !== undefined && (!isOperationAccess(access) || access.kind === "public")) {
    throw new MailPreviewError(
      "mail preview access must be a non-public access declaration created by the kernel helpers",
      "access",
    );
  }
}
