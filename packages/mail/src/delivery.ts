import type {
  AnyMailer,
  InferSchemaInput,
  JobEnqueueDependencyToken,
  JobEnqueueOptions,
  JobEnqueuer,
  JobRetention,
  JobRetry,
  MailEnvelope,
  MailInterceptor,
  MailLedger,
  MailProvider,
  MailSendRecord,
  RuntimeSchema,
} from "@sixthsummit/ship-core";
import {
  adaptedJobDependency,
  arraySchema,
  defineJob,
  isMailAddress,
  isMailer,
  isMailInterceptor,
  jsonValueSchema,
  MailRenderError,
  mailLedgerDependency,
  mailProviderDependency,
  objectSchema,
  operationError,
  operationFailure,
  optionalSchema,
  recordSchema,
  renderMailMessage,
  stringSchema,
  validateMailPayload,
} from "@sixthsummit/ship-core";

const JOB_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[^\s]{1,200}$/u;

/** Default retry policy: five attempts over roughly twenty minutes. */
export const DEFAULT_MAIL_RETRY: JobRetry = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ initialMs: 2_000, multiplier: 4, maxMs: 15 * 60_000 }),
});
/** A `sending` ledger claim older than this is treated as abandoned and retaken. */
export const DEFAULT_MAIL_CLAIM_LEASE_MS = 5 * 60_000;
export const DEFAULT_MAIL_DELIVERY_ID = "mail.deliver" as const;

// ---------------------------------------------------------------------------
// Job input and declared failures
// ---------------------------------------------------------------------------

const addressListSchema = arraySchema(stringSchema({ minLength: 3 }));

/** The job payload: everything delivery needs, serializable, with no template output. */
export const mailDeliveryInputSchema = objectSchema({
  mailerId: stringSchema({ minLength: 1 }),
  message: stringSchema({ minLength: 1 }),
  to: addressListSchema,
  cc: optionalSchema(addressListSchema),
  bcc: optionalSchema(addressListSchema),
  replyTo: optionalSchema(stringSchema({ minLength: 3 })),
  payload: jsonValueSchema(),
  idempotencyKey: stringSchema({ minLength: 1 }),
  tenantId: optionalSchema(stringSchema({ minLength: 1 })),
  headers: optionalSchema(recordSchema(stringSchema())),
});

export type MailDeliveryInput = InferSchemaInput<typeof mailDeliveryInputSchema>;

/** The mailer or message named by a send is not registered with this delivery. */
export const mailMessageUnknown = operationError({
  code: "MAIL_MESSAGE_UNKNOWN",
  status: 422,
  message: "Mail message is not declared",
  details: objectSchema({ mailerId: stringSchema(), message: stringSchema() }),
});

/** The stored payload no longer satisfies the message schema (never retried). */
export const mailPayloadInvalid = operationError({
  code: "MAIL_PAYLOAD_INVALID",
  status: 422,
  message: "Mail payload does not match the declared schema",
  details: objectSchema({ mailerId: stringSchema(), message: stringSchema() }),
});

/** The provider rejected the message with a final (non-retryable) outcome. */
export const mailRejected = operationError({
  code: "MAIL_REJECTED",
  status: 502,
  message: "Mail provider rejected the message",
  details: objectSchema({ provider: stringSchema(), error: stringSchema() }),
});

export type MailDeliveryErrorCode =
  | "SHIP_MAIL_DELIVERY_OPTIONS_INVALID"
  | "SHIP_MAIL_SEND_IN_FLIGHT"
  | "SHIP_MAIL_PROVIDER_FAILED";

/** Thrown by the delivery handler for retryable outcomes; the job retries with backoff. */
export class MailDeliveryError extends Error {
  readonly code: MailDeliveryErrorCode;
  readonly idempotencyKey?: string;
  readonly field?: string;

  constructor(
    code: MailDeliveryErrorCode,
    message: string,
    options: {
      readonly idempotencyKey?: string;
      readonly field?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MailDeliveryError";
    this.code = code;
    this.idempotencyKey = options.idempotencyKey;
    this.field = options.field;
  }
}

// ---------------------------------------------------------------------------
// Sender (what an operation receives for `delivery.dependency`)
// ---------------------------------------------------------------------------

export interface MailSendOptions<TPayload> {
  readonly to: string | readonly string[];
  readonly payload: TPayload;
  /**
   * Globally unique per logical send (for example `welcome:${accountId}`).
   * Enqueue deduplicates on it while a run is live and the ledger refuses a
   * second provider call for it forever after.
   */
  readonly idempotencyKey: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Recorded on the ledger row so a tenant's sends can be listed. */
  readonly tenantId?: string;
  readonly delayMs?: number;
}

export type MailSendResult =
  | { readonly accepted: true; readonly sendId: string; readonly deduplicated: boolean }
  | { readonly accepted: false; readonly rejected: "queue-full" };

type MessagePayload<
  TMailer extends AnyMailer,
  TName extends string,
> = TMailer["messages"][TName] extends {
  readonly payload: infer TSchema extends RuntimeSchema;
}
  ? InferSchemaInput<TSchema>
  : never;

export interface MailSender<TMailers extends readonly AnyMailer[] = readonly AnyMailer[]> {
  readonly kind: "ship.mail-sender";
  readonly jobId: string;
  send<TMailer extends TMailers[number], TName extends keyof TMailer["messages"] & string>(
    mailer: TMailer,
    message: TName,
    options: MailSendOptions<MessagePayload<TMailer, TName>>,
  ): Promise<MailSendResult>;
}

export type MailSendErrorCode =
  | "SHIP_MAIL_MAILER_UNREGISTERED"
  | "SHIP_MAIL_RECIPIENT_INVALID"
  | "SHIP_MAIL_IDEMPOTENCY_KEY_INVALID";

export class MailSendError extends Error {
  readonly code: MailSendErrorCode;
  readonly mailerId: string;
  readonly messageName: string;

  constructor(
    code: MailSendErrorCode,
    message: string,
    options: { readonly mailerId: string; readonly messageName: string },
  ) {
    super(message);
    this.name = "MailSendError";
    this.code = code;
    this.mailerId = options.mailerId;
    this.messageName = options.messageName;
  }
}

function createMailSender<TMailers extends readonly AnyMailer[]>(
  jobId: string,
  mailers: ReadonlyMap<string, AnyMailer>,
  enqueuer: JobEnqueuer<typeof mailDeliveryInputSchema>,
): MailSender<TMailers> {
  const send = async (
    mailer: AnyMailer,
    message: string,
    options: MailSendOptions<unknown>,
  ): Promise<MailSendResult> => {
    if (!isMailer(mailer) || mailers.get(mailer.id) !== mailer) {
      throw new MailSendError(
        "SHIP_MAIL_MAILER_UNREGISTERED",
        `mailer ${JSON.stringify(mailer?.id)} is not registered with delivery job ${JSON.stringify(jobId)}; add it to defineMailDelivery({ mailers })`,
        { mailerId: String(mailer?.id), messageName: message },
      );
    }
    const to = typeof options.to === "string" ? [options.to] : [...(options.to ?? [])];
    for (const address of [...to, ...(options.cc ?? []), ...(options.bcc ?? [])]) {
      if (!isMailAddress(address)) {
        throw new MailSendError(
          "SHIP_MAIL_RECIPIENT_INVALID",
          `recipient ${JSON.stringify(address)} is not an email address`,
          { mailerId: mailer.id, messageName: message },
        );
      }
    }
    if (to.length === 0) {
      throw new MailSendError(
        "SHIP_MAIL_RECIPIENT_INVALID",
        "a send needs at least one recipient",
        {
          mailerId: mailer.id,
          messageName: message,
        },
      );
    }
    if (
      typeof options.idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)
    ) {
      throw new MailSendError(
        "SHIP_MAIL_IDEMPOTENCY_KEY_INVALID",
        "idempotencyKey must be a non-empty string without whitespace (at most 200 characters)",
        { mailerId: mailer.id, messageName: message },
      );
    }
    // Validation and rendering errors surface at the call site, not in a dead letter.
    const payload = await validateMailPayload(mailer, message, options.payload);
    const input: MailDeliveryInput = {
      mailerId: mailer.id,
      message,
      to,
      ...(options.cc && options.cc.length > 0 ? { cc: [...options.cc] } : {}),
      ...(options.bcc && options.bcc.length > 0 ? { bcc: [...options.bcc] } : {}),
      ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
      payload,
      idempotencyKey: options.idempotencyKey,
      ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
      ...(options.headers ? { headers: { ...options.headers } } : {}),
    };
    const enqueueOptions: JobEnqueueOptions = {
      dedupeKey: options.idempotencyKey,
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
    };
    const result = await enqueuer.enqueue(input, enqueueOptions);
    return result.accepted
      ? Object.freeze({
          accepted: true as const,
          sendId: result.runId,
          deduplicated: result.deduplicated,
        })
      : Object.freeze({ accepted: false as const, rejected: "queue-full" as const });
  };
  return Object.freeze({ kind: "ship.mail-sender" as const, jobId, send }) as MailSender<TMailers>;
}

// ---------------------------------------------------------------------------
// Delivery declaration
// ---------------------------------------------------------------------------

export interface MailDeliveryOptions<
  TMailers extends readonly AnyMailer[],
  TId extends string = typeof DEFAULT_MAIL_DELIVERY_ID,
> {
  /** Defaults to `mail.deliver`; the first segment is the module that composes the job. */
  readonly id?: TId;
  /** Every mailer that may be sent through this job. */
  readonly mailers: TMailers;
  /** Sender used by mailers that declare no `from`; required when any of them does not. */
  readonly from?: string;
  /** Non-production allowlist guard; omit in production. */
  readonly interceptor?: MailInterceptor;
  readonly retry?: JobRetry;
  /** Per-process in-flight sends. Defaults to 4. */
  readonly maxInFlight?: number;
  readonly retention?: JobRetention;
  readonly claimLeaseMs?: number;
  readonly clock?: () => Date;
}

/** What a delivery run returns; `duplicate` means the ledger already held a sent row. */
export interface MailDeliveryOutput {
  readonly status: "sent" | "duplicate";
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly providerMessageId?: string;
  readonly intercepted: boolean;
}

/**
 * Compiles the delivery job. A send is an enqueued run of this job: the
 * handler renders the message, applies the interceptor, claims the ledger
 * row for the idempotency key, calls the provider exactly once per claim and
 * records the outcome. Retry, backoff, dead-lettering and management come
 * from the jobs capability unchanged.
 */
export function defineMailDelivery<
  const TMailers extends readonly AnyMailer[],
  const TId extends string = typeof DEFAULT_MAIL_DELIVERY_ID,
>(options: MailDeliveryOptions<TMailers, TId>) {
  assertOptions(options);
  // Literal so `operationById` keeps a literal key; a `string` id would widen the
  // application's operation map into an index signature and erase every client id.
  const id = (options.id ?? DEFAULT_MAIL_DELIVERY_ID) as TId;
  const clock = options.clock ?? (() => new Date());
  const leaseMs = options.claimLeaseMs ?? DEFAULT_MAIL_CLAIM_LEASE_MS;
  const mailers = new Map<string, AnyMailer>(options.mailers.map((mailer) => [mailer.id, mailer]));
  const provider = mailProviderDependency();
  const ledger = mailLedgerDependency();

  const job = defineJob({
    id,
    input: mailDeliveryInputSchema,
    trigger: { kind: "enqueue" },
    concurrency: { mode: "parallel", max: options.maxInFlight ?? 4 },
    retry: options.retry ?? DEFAULT_MAIL_RETRY,
    ...(options.retention ? { retention: options.retention } : {}),
    transaction: "none",
    dependencies: { provider, ledger },
    effects: [provider],
    errors: [mailMessageUnknown, mailPayloadInvalid, mailRejected],
    handler: async ({ input, services }): Promise<MailDeliveryOutput> => {
      const mailer = mailers.get(input.mailerId);
      if (!mailer || !(input.message in mailer.messages)) {
        throw operationFailure(mailMessageUnknown, {
          details: { mailerId: input.mailerId, message: input.message },
        });
      }
      let rendered: Awaited<ReturnType<typeof renderMailMessage>>;
      try {
        rendered = await renderMailMessage(mailer, input.message, input.payload);
      } catch (error) {
        if (error instanceof MailRenderError && error.code === "SHIP_MAIL_PAYLOAD_INVALID") {
          throw operationFailure(mailPayloadInvalid, {
            details: { mailerId: input.mailerId, message: input.message },
            cause: error,
          });
        }
        throw error;
      }
      const addressed: MailEnvelope = Object.freeze({
        from: mailer.from ?? (options.from as string),
        to: input.to,
        ...(input.cc ? { cc: input.cc } : {}),
        ...(input.bcc ? { bcc: input.bcc } : {}),
        ...(input.replyTo !== undefined
          ? { replyTo: input.replyTo }
          : mailer.replyTo !== undefined
            ? { replyTo: mailer.replyTo }
            : {}),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(input.headers ? { headers: input.headers } : {}),
      });
      const interception = options.interceptor
        ? options.interceptor.intercept(addressed)
        : { envelope: addressed, intercepted: false };
      const mailProvider = services.provider as MailProvider;
      const mailLedger = services.ledger as MailLedger;
      const now = clock();
      const claim = await mailLedger.claim({
        idempotencyKey: input.idempotencyKey,
        mailerId: input.mailerId,
        message: input.message,
        to: input.to,
        deliveredTo: interception.envelope.to,
        intercepted: interception.intercepted,
        subject: rendered.subject,
        provider: mailProvider.adapter,
        ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
        now,
        leaseMs,
      });
      if (claim.outcome === "sent") {
        return duplicate(claim.record);
      }
      if (claim.outcome === "in-flight") {
        throw new MailDeliveryError(
          "SHIP_MAIL_SEND_IN_FLIGHT",
          `send ${JSON.stringify(input.idempotencyKey)} is being delivered by another run; retrying after backoff`,
          { idempotencyKey: input.idempotencyKey },
        );
      }
      const outcome = await mailProvider.send({
        envelope: interception.envelope,
        idempotencyKey: input.idempotencyKey,
        mailerId: input.mailerId,
        message: input.message,
      });
      const finishedAt = clock();
      if (outcome.accepted) {
        await mailLedger.markSent(input.idempotencyKey, {
          ...(outcome.providerMessageId !== undefined
            ? { providerMessageId: outcome.providerMessageId }
            : {}),
          now: finishedAt,
        });
        return Object.freeze({
          status: "sent" as const,
          idempotencyKey: input.idempotencyKey,
          attempt: claim.attempt,
          ...(outcome.providerMessageId !== undefined
            ? { providerMessageId: outcome.providerMessageId }
            : {}),
          intercepted: interception.intercepted,
        });
      }
      await mailLedger.markFailed(input.idempotencyKey, { error: outcome.error, now: finishedAt });
      if (outcome.retryable) {
        throw new MailDeliveryError(
          "SHIP_MAIL_PROVIDER_FAILED",
          `provider ${JSON.stringify(mailProvider.adapter)} failed to accept send ${JSON.stringify(input.idempotencyKey)}: ${outcome.error}`,
          { idempotencyKey: input.idempotencyKey },
        );
      }
      throw operationFailure(mailRejected, {
        details: { provider: mailProvider.adapter, error: outcome.error },
      });
    },
  });

  const dependency = adaptedJobDependency(job, (enqueuer) =>
    createMailSender<TMailers>(id, mailers, enqueuer),
  ) as JobEnqueueDependencyToken<typeof mailDeliveryInputSchema, MailSender<TMailers>>;

  return Object.freeze({
    kind: "ship.mail-delivery" as const,
    id,
    job,
    mailers: Object.freeze([...options.mailers]) as TMailers,
    /** Bind this in an operation's `dependencies` to receive a typed `MailSender`. */
    dependency,
  });
}

export type MailDelivery<
  TMailers extends readonly AnyMailer[] = readonly AnyMailer[],
  TId extends string = typeof DEFAULT_MAIL_DELIVERY_ID,
> = ReturnType<typeof defineMailDelivery<TMailers, TId>>;

function duplicate(record: MailSendRecord): MailDeliveryOutput {
  return Object.freeze({
    status: "duplicate" as const,
    idempotencyKey: record.idempotencyKey,
    attempt: record.attempts,
    ...(record.providerMessageId !== undefined
      ? { providerMessageId: record.providerMessageId }
      : {}),
    intercepted: record.intercepted,
  });
}

function assertOptions(
  options: unknown,
): asserts options is MailDeliveryOptions<readonly AnyMailer[]> {
  if (typeof options !== "object" || options === null) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery options must be an object",
      { field: "options" },
    );
  }
  const id = Reflect.get(options, "id");
  if (id !== undefined && (typeof id !== "string" || !JOB_ID_PATTERN.test(id))) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery id must contain at least two lowercase dot-separated segments",
      { field: "id" },
    );
  }
  const mailers = Reflect.get(options, "mailers");
  if (!Array.isArray(mailers) || mailers.length === 0 || !mailers.every((item) => isMailer(item))) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery mailers must be a non-empty array of defineMailer() results",
      { field: "mailers" },
    );
  }
  const ids = new Set<string>();
  for (const mailer of mailers as AnyMailer[]) {
    if (ids.has(mailer.id)) {
      throw new MailDeliveryError(
        "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
        `mailer ${JSON.stringify(mailer.id)} is registered twice`,
        { field: "mailers" },
      );
    }
    ids.add(mailer.id);
  }
  const from = Reflect.get(options, "from");
  if (from !== undefined && !isMailAddress(from)) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery from must be an email address or `Display Name <address>`",
      { field: "from" },
    );
  }
  const missingFrom = (mailers as AnyMailer[]).filter((mailer) => mailer.from === undefined);
  if (from === undefined && missingFrom.length > 0) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      `mailer ${JSON.stringify(missingFrom[0]?.id)} declares no from and the delivery has no default; set defineMailDelivery({ from }) or the mailer's from`,
      { field: "from" },
    );
  }
  const interceptor = Reflect.get(options, "interceptor");
  if (interceptor !== undefined && !isMailInterceptor(interceptor)) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery interceptor must be a MailInterceptor (for example allowlistInterceptor())",
      { field: "interceptor" },
    );
  }
  const maxInFlight = Reflect.get(options, "maxInFlight");
  if (
    maxInFlight !== undefined &&
    !(typeof maxInFlight === "number" && Number.isInteger(maxInFlight) && maxInFlight > 0)
  ) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery maxInFlight must be a positive integer",
      { field: "maxInFlight" },
    );
  }
  const claimLeaseMs = Reflect.get(options, "claimLeaseMs");
  if (
    claimLeaseMs !== undefined &&
    !(typeof claimLeaseMs === "number" && Number.isInteger(claimLeaseMs) && claimLeaseMs > 0)
  ) {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery claimLeaseMs must be a positive integer",
      { field: "claimLeaseMs" },
    );
  }
  const clock = Reflect.get(options, "clock");
  if (clock !== undefined && typeof clock !== "function") {
    throw new MailDeliveryError(
      "SHIP_MAIL_DELIVERY_OPTIONS_INVALID",
      "mail delivery clock must be a function",
      { field: "clock" },
    );
  }
}
