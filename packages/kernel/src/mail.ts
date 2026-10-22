import type { ApplicationDiagnostic } from "./application.js";
import type { DependencyToken, EffectDependencyToken } from "./dependency.js";
import { dependency, effectDependency } from "./dependency.js";
import type { AnyModule } from "./module.js";
import type { InferSchemaInput, InferSchemaOutput, RuntimeSchema, SchemaResult } from "./schema.js";
import { isRuntimeSchema } from "./schema.js";

const MAILER_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u;
const MESSAGE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/u;
/** A pragmatic address check: one `@`, no whitespace, no control characters. */
const ADDRESS_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u;
/** `Name <address>` or a bare address. */
const NAMED_ADDRESS_PATTERN = /^[^<>\r\n]*<([^\s<>]+)>$/u;

/** Provider id every application binds its `MailProvider` to. */
export const MAIL_PROVIDER_ID = "ship.mail.provider";
/** Provider id every application binds its `MailLedger` to. */
export const MAIL_LEDGER_ID = "ship.mail.ledger";
/** Header carrying the original recipients when a non-production interceptor redirected a send. */
export const MAIL_ORIGINAL_TO_HEADER = "X-Ship-Original-To";

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/** What a message template produces from its validated payload. */
export interface MailRendering {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface MailMessageDefinition<TPayload extends RuntimeSchema = RuntimeSchema> {
  /** Standard Schema the payload is validated against at enqueue and at delivery. */
  readonly payload: TPayload;
  /**
   * Pure template: subject, HTML and plain text from the validated payload.
   * It performs no I/O and receives nothing but the payload, so the same
   * function renders previews, tests and production sends identically.
   */
  readonly render: (payload: InferSchemaOutput<TPayload>) => MailRendering;
  /** Sample payload the development preview renders; validated against `payload`. */
  readonly sample?: InferSchemaInput<TPayload>;
  readonly description?: string;
}

export type MailMessageDefinitions = Readonly<Record<string, MailMessageDefinition<RuntimeSchema>>>;

export interface MailerDefinition<TId extends string, TMessages extends MailMessageDefinitions> {
  readonly id: TId;
  /** Default sender for every message; the delivery package may require it when it has no default of its own. */
  readonly from?: string;
  readonly replyTo?: string;
  readonly messages: TMessages;
}

export interface Mailer<TId extends string, TMessages extends MailMessageDefinitions> {
  readonly kind: "ship.mailer";
  readonly id: TId;
  readonly from?: string;
  readonly replyTo?: string;
  readonly messages: TMessages;
  /** Declared message names in declaration order. */
  readonly messageNames: readonly (keyof TMessages & string)[];
}

export interface AnyMailer {
  readonly kind: "ship.mailer";
  readonly id: string;
  readonly from?: string;
  readonly replyTo?: string;
  readonly messages: MailMessageDefinitions;
  readonly messageNames: readonly string[];
}

export type MailerDefinitionDiagnosticCode =
  | "SHIP_MAILER_DEFINITION_INVALID"
  | "SHIP_MAILER_ID_INVALID"
  | "SHIP_MAILER_FROM_INVALID"
  | "SHIP_MAILER_REPLY_TO_INVALID"
  | "SHIP_MAILER_MESSAGES_EMPTY"
  | "SHIP_MAILER_MESSAGE_NAME_INVALID"
  | "SHIP_MAILER_MESSAGE_PAYLOAD_INVALID"
  | "SHIP_MAILER_MESSAGE_RENDER_INVALID"
  | "SHIP_MAILER_MESSAGE_DESCRIPTION_INVALID";

export class InvalidMailerDefinitionError extends Error {
  readonly code: MailerDefinitionDiagnosticCode;
  readonly mailerId?: string;
  readonly field?: string;

  constructor(
    code: MailerDefinitionDiagnosticCode,
    message: string,
    options: { readonly mailerId?: string; readonly field?: string } = {},
  ) {
    super(message);
    this.name = "InvalidMailerDefinitionError";
    this.code = code;
    this.mailerId = options.mailerId;
    this.field = options.field;
  }
}

/**
 * Declares a mailer: a named group of typed messages, each with a payload
 * schema and a pure HTML + text template. A mailer is declared on exactly one
 * module (`defineModule({ mailers })`) so the graph and client contract can
 * enumerate every message by name; delivery is the job of
 * `@sixthsummit/ship-mail`, which sends through the jobs capability.
 */
export function defineMailer<const TId extends string, const TMessages extends MailMessageDefinitions>(
  definition: MailerDefinition<TId, TMessages>,
): Mailer<TId, TMessages> {
  assertMailerDefinition(definition);
  const messages = Object.freeze(
    Object.fromEntries(
      Object.entries(definition.messages).map(([name, message]) => [
        name,
        Object.freeze({
          payload: message.payload,
          render: message.render,
          ...(message.sample !== undefined ? { sample: message.sample } : {}),
          ...(message.description !== undefined ? { description: message.description } : {}),
        }),
      ]),
    ),
  ) as TMessages;
  return Object.freeze({
    kind: "ship.mailer" as const,
    id: definition.id,
    ...(definition.from !== undefined ? { from: definition.from } : {}),
    ...(definition.replyTo !== undefined ? { replyTo: definition.replyTo } : {}),
    messages,
    messageNames: Object.freeze(Object.keys(messages)) as readonly (keyof TMessages & string)[],
  });
}

export function isMailer(value: unknown): value is AnyMailer {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.mailer" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "messages") === "object" &&
    Reflect.get(value, "messages") !== null &&
    Array.isArray(Reflect.get(value, "messageNames"))
  );
}

/** True for a bare address or a `Display Name <address>` form. */
export function isMailAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 320) return false;
  const named = NAMED_ADDRESS_PATTERN.exec(value);
  return ADDRESS_PATTERN.test(named ? (named[1] as string) : value);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type MailRenderErrorCode =
  | "SHIP_MAIL_MESSAGE_UNKNOWN"
  | "SHIP_MAIL_PAYLOAD_INVALID"
  | "SHIP_MAIL_RENDERING_INVALID";

export class MailRenderError extends Error {
  readonly code: MailRenderErrorCode;
  readonly mailerId: string;
  /** The message name the failure concerns. */
  readonly messageName: string;
  readonly issues?: readonly { readonly message: string; readonly path: readonly PropertyKey[] }[];

  constructor(
    code: MailRenderErrorCode,
    message: string,
    options: {
      readonly mailerId: string;
      readonly messageName: string;
      readonly issues?: readonly {
        readonly message: string;
        readonly path: readonly PropertyKey[];
      }[];
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "MailRenderError";
    this.code = code;
    this.mailerId = options.mailerId;
    this.messageName = options.messageName;
    this.issues = options.issues;
  }
}

export interface RenderedMail extends MailRendering {
  readonly mailerId: string;
  readonly message: string;
  /** The validated (schema output) payload the template received. */
  readonly payload: unknown;
}

/** Validates `payload` against the message schema and returns the schema output. */
export async function validateMailPayload(
  mailer: AnyMailer,
  message: string,
  payload: unknown,
): Promise<unknown> {
  const definition = mailer.messages[message];
  if (!definition) {
    throw new MailRenderError(
      "SHIP_MAIL_MESSAGE_UNKNOWN",
      `mailer ${JSON.stringify(mailer.id)} declares no message ${JSON.stringify(message)}`,
      { mailerId: mailer.id, messageName: message },
    );
  }
  const result = (await definition.payload["~standard"].validate(payload)) as SchemaResult<unknown>;
  if ("issues" in result && result.issues !== undefined) {
    throw new MailRenderError(
      "SHIP_MAIL_PAYLOAD_INVALID",
      `payload for ${JSON.stringify(`${mailer.id}.${message}`)} does not match its declared schema`,
      {
        mailerId: mailer.id,
        messageName: message,
        issues: result.issues.map((item) => ({
          message: item.message,
          path: (item.path ?? []).map((segment) =>
            typeof segment === "object" && segment !== null ? segment.key : segment,
          ),
        })),
      },
    );
  }
  return result.value;
}

/**
 * Validates the payload, runs the template and checks its output. The same
 * function serves delivery, previews and tests; it never performs I/O.
 */
export async function renderMailMessage(
  mailer: AnyMailer,
  message: string,
  payload: unknown,
): Promise<RenderedMail> {
  const validated = await validateMailPayload(mailer, message, payload);
  const definition = mailer.messages[message] as MailMessageDefinition<RuntimeSchema>;
  let rendering: unknown;
  try {
    rendering = definition.render(validated);
  } catch (cause) {
    throw new MailRenderError(
      "SHIP_MAIL_RENDERING_INVALID",
      `template for ${JSON.stringify(`${mailer.id}.${message}`)} threw while rendering`,
      { mailerId: mailer.id, messageName: message, cause },
    );
  }
  if (!isMailRendering(rendering)) {
    throw new MailRenderError(
      "SHIP_MAIL_RENDERING_INVALID",
      `template for ${JSON.stringify(`${mailer.id}.${message}`)} must return non-empty subject, html and text strings`,
      { mailerId: mailer.id, messageName: message },
    );
  }
  return Object.freeze({
    mailerId: mailer.id,
    message,
    payload: validated,
    subject: rendering.subject,
    html: rendering.html,
    text: rendering.text,
  });
}

export function isMailRendering(value: unknown): value is MailRendering {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "subject") === "string" &&
    (Reflect.get(value, "subject") as string).trim().length > 0 &&
    typeof Reflect.get(value, "html") === "string" &&
    (Reflect.get(value, "html") as string).length > 0 &&
    typeof Reflect.get(value, "text") === "string" &&
    (Reflect.get(value, "text") as string).length > 0
  );
}

// ---------------------------------------------------------------------------
// Adapter contracts (implemented outside the kernel)
// ---------------------------------------------------------------------------

/** One message as handed to a provider: fully rendered, addressed and headed. */
export interface MailEnvelope {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** Custom headers; interceptors add `X-Ship-Original-To` here. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface MailSendRequest {
  readonly envelope: MailEnvelope;
  /** Consumer-chosen key; providers that support it forward it so a repeated call cannot double-send. */
  readonly idempotencyKey: string;
  readonly mailerId: string;
  readonly message: string;
}

export type MailProviderOutcome =
  | { readonly accepted: true; readonly providerMessageId?: string }
  | {
      readonly accepted: false;
      /** Network, rate-limit and 5xx outcomes retry; a provider rejection is final. */
      readonly retryable: boolean;
      readonly error: string;
      readonly status?: number;
    };

/**
 * Delivery adapter. `accepted` means provider acceptance, never inbox
 * delivery. A provider must tolerate repeated calls with one idempotency key
 * because job delivery is at-least-once.
 */
export interface MailProvider {
  readonly kind: "ship.mail-provider";
  readonly adapter: string;
  send(request: MailSendRequest): Promise<MailProviderOutcome>;
}

export function isMailProvider(value: unknown): value is MailProvider {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.mail-provider" &&
    typeof Reflect.get(value, "adapter") === "string" &&
    typeof Reflect.get(value, "send") === "function"
  );
}

export type MailSendStatus = "sending" | "sent" | "failed";

/** One row of the send ledger: the durable answer to "did this person get this email". */
export interface MailSendRecord {
  readonly idempotencyKey: string;
  readonly mailerId: string;
  readonly message: string;
  /** Recipients the application addressed. */
  readonly to: readonly string[];
  /** Recipients the provider was asked to deliver to; differs from `to` when intercepted. */
  readonly deliveredTo: readonly string[];
  readonly intercepted: boolean;
  readonly subject: string;
  readonly status: MailSendStatus;
  /** Delivery attempts claimed so far. */
  readonly attempts: number;
  readonly provider: string;
  readonly providerMessageId?: string;
  readonly lastError?: string;
  readonly tenantId?: string;
  readonly createdAt: Date;
  readonly claimedAt: Date;
  readonly sentAt?: Date;
  readonly failedAt?: Date;
}

export interface MailLedgerClaim {
  readonly idempotencyKey: string;
  readonly mailerId: string;
  readonly message: string;
  readonly to: readonly string[];
  readonly deliveredTo: readonly string[];
  readonly intercepted: boolean;
  readonly subject: string;
  readonly provider: string;
  readonly tenantId?: string;
  readonly now: Date;
  /** A `sending` claim older than this is considered abandoned and may be retaken. */
  readonly leaseMs: number;
}

export type MailLedgerClaimResult =
  | { readonly outcome: "claimed"; readonly attempt: number }
  | { readonly outcome: "sent"; readonly record: MailSendRecord }
  | { readonly outcome: "in-flight"; readonly record: MailSendRecord };

export interface MailLedgerQuery {
  readonly recipient?: string;
  readonly mailerId?: string;
  readonly message?: string;
  readonly tenantId?: string;
  readonly limit: number;
}

/**
 * Durable per-send ledger keyed by idempotency key. `claim` is the guard that
 * makes a replayed delivery run safe: a key already `sent` is answered from
 * the ledger, a stale `sending` claim or a `failed` row is retaken, and a
 * live `sending` claim reports `in-flight` so the caller retries later.
 */
export interface MailLedger {
  readonly kind: "ship.mail-ledger";
  readonly adapter: string;
  claim(claim: MailLedgerClaim): Promise<MailLedgerClaimResult>;
  markSent(
    idempotencyKey: string,
    outcome: { readonly providerMessageId?: string; readonly now: Date },
  ): Promise<void>;
  markFailed(idempotencyKey: string, outcome: { readonly error: string; readonly now: Date }): Promise<void>;
  find(idempotencyKey: string): Promise<MailSendRecord | undefined>;
  list(query: MailLedgerQuery): Promise<readonly MailSendRecord[]>;
  /** Deletes terminal rows created before `before`; returns how many were removed. */
  cleanup(options: { readonly before: Date }): Promise<{ readonly deleted: number }>;
}

export function isMailLedger(value: unknown): value is MailLedger {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.mail-ledger" &&
    typeof Reflect.get(value, "adapter") === "string" &&
    ["claim", "markSent", "markFailed", "find", "list", "cleanup"].every(
      (method) => typeof Reflect.get(value, method) === "function",
    )
  );
}

/**
 * Non-production guard applied before the ledger claim and the provider call:
 * every recipient outside an allowlist is replaced, and the original
 * recipients travel in `X-Ship-Original-To`.
 */
export interface MailInterceptor {
  readonly kind: "ship.mail-interceptor";
  readonly adapter: string;
  intercept(envelope: MailEnvelope): MailInterception;
}

export interface MailInterception {
  readonly envelope: MailEnvelope;
  readonly intercepted: boolean;
}

export function isMailInterceptor(value: unknown): value is MailInterceptor {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "kind") === "ship.mail-interceptor" &&
    typeof Reflect.get(value, "adapter") === "string" &&
    typeof Reflect.get(value, "intercept") === "function"
  );
}

// ---------------------------------------------------------------------------
// Dependency tokens
// ---------------------------------------------------------------------------

/** The provider is an immediate external effect; only `transaction: "none"` operations may bind it. */
export function mailProviderDependency(): EffectDependencyToken<MailProvider> {
  return effectDependency<MailProvider>(MAIL_PROVIDER_ID, { delivery: "immediate" });
}

export function mailLedgerDependency(): DependencyToken<MailLedger> {
  return dependency<MailLedger>(MAIL_LEDGER_ID);
}

// ---------------------------------------------------------------------------
// Compilation and graph projection helpers used by application.ts
// ---------------------------------------------------------------------------

export interface MailerGraphNode {
  readonly id: string;
  readonly moduleId: string;
  readonly from?: string;
  readonly messages: readonly string[];
}

export function collectMailerOwners(
  appId: string,
  modules: readonly AnyModule[],
  diagnostics: ApplicationDiagnostic[],
): ReadonlyMap<string, { readonly module: AnyModule; readonly mailer: AnyMailer }> {
  const owners = new Map<string, { module: AnyModule; mailer: AnyMailer }>();
  for (const module of [...modules].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const mailer of [...(module.mailers ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const previous = owners.get(mailer.id);
      if (previous) {
        diagnostics.push({
          code: "SHIP_MAILER_ID_DUPLICATE",
          severity: "error",
          message: `mailer id ${JSON.stringify(mailer.id)} is declared by both ${JSON.stringify(previous.module.id)} and ${JSON.stringify(module.id)}`,
          hint: "Declare each mailer in exactly one module; previews, the ledger and the client contract key messages by mailer id.",
          appId,
          moduleId: module.id,
          path: "mailers",
        });
        continue;
      }
      owners.set(mailer.id, { module, mailer });
      if (!mailer.id.startsWith(`${module.id}.`)) {
        diagnostics.push({
          code: "SHIP_MAILER_ID_MISMATCH",
          severity: "error",
          message: `mailer ${JSON.stringify(mailer.id)} is not namespaced by module ${JSON.stringify(module.id)}`,
          hint: `Mailer ids are namespaced by the module that owns them: rename the mailer so its id starts with ${JSON.stringify(`${module.id}.`)}.`,
          appId,
          moduleId: module.id,
          path: "mailers",
        });
      }
    }
  }
  return owners;
}

export function projectMailers(modules: readonly AnyModule[]): readonly MailerGraphNode[] {
  const nodes: MailerGraphNode[] = [];
  for (const module of modules) {
    for (const mailer of module.mailers ?? []) {
      nodes.push(
        Object.freeze({
          id: mailer.id,
          moduleId: module.id,
          ...(mailer.from !== undefined ? { from: mailer.from } : {}),
          messages: Object.freeze([...mailer.messageNames].sort()),
        }),
      );
    }
  }
  return Object.freeze(nodes.sort((left, right) => left.id.localeCompare(right.id)));
}

/** Every mailer composed into an application, sorted by id. */
export function collectMailers(modules: readonly AnyModule[]): readonly AnyMailer[] {
  return Object.freeze(
    modules
      .flatMap((module) => module.mailers ?? [])
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertMailerDefinition(
  definition: unknown,
): asserts definition is MailerDefinition<string, MailMessageDefinitions> {
  if (typeof definition !== "object" || definition === null) {
    fail("SHIP_MAILER_DEFINITION_INVALID", "mailer definition must be an object");
  }
  const id = Reflect.get(definition, "id");
  const mailerId = typeof id === "string" ? id : undefined;
  if (!mailerId || !MAILER_ID_PATTERN.test(mailerId)) {
    fail(
      "SHIP_MAILER_ID_INVALID",
      "mailer id must contain at least two lowercase dot-separated segments (the owning module id first)",
      mailerId,
      "id",
    );
  }
  const from = Reflect.get(definition, "from");
  if (from !== undefined && !isMailAddress(from)) {
    fail(
      "SHIP_MAILER_FROM_INVALID",
      "mailer from must be an email address or `Display Name <address>`",
      mailerId,
      "from",
    );
  }
  const replyTo = Reflect.get(definition, "replyTo");
  if (replyTo !== undefined && !isMailAddress(replyTo)) {
    fail(
      "SHIP_MAILER_REPLY_TO_INVALID",
      "mailer replyTo must be an email address or `Display Name <address>`",
      mailerId,
      "replyTo",
    );
  }
  const messages = Reflect.get(definition, "messages");
  if (
    typeof messages !== "object" ||
    messages === null ||
    Array.isArray(messages) ||
    Object.keys(messages).length === 0
  ) {
    fail(
      "SHIP_MAILER_MESSAGES_EMPTY",
      `mailer ${JSON.stringify(mailerId)} declares no messages; declare at least one named message with a payload schema and a render function`,
      mailerId,
      "messages",
    );
  }
  for (const [name, message] of Object.entries(messages)) {
    if (!MESSAGE_NAME_PATTERN.test(name)) {
      fail(
        "SHIP_MAILER_MESSAGE_NAME_INVALID",
        `message name ${JSON.stringify(name)} must be a lowerCamelCase identifier`,
        mailerId,
        `messages.${name}`,
      );
    }
    if (typeof message !== "object" || message === null) {
      fail(
        "SHIP_MAILER_MESSAGE_PAYLOAD_INVALID",
        `message ${JSON.stringify(name)} must declare a payload schema and a render function`,
        mailerId,
        `messages.${name}`,
      );
    }
    if (!isRuntimeSchema(Reflect.get(message, "payload"))) {
      fail(
        "SHIP_MAILER_MESSAGE_PAYLOAD_INVALID",
        `message ${JSON.stringify(name)} payload must be a Standard Schema`,
        mailerId,
        `messages.${name}.payload`,
      );
    }
    if (typeof Reflect.get(message, "render") !== "function") {
      fail(
        "SHIP_MAILER_MESSAGE_RENDER_INVALID",
        `message ${JSON.stringify(name)} render must be a function returning { subject, html, text }`,
        mailerId,
        `messages.${name}.render`,
      );
    }
    const description = Reflect.get(message, "description");
    if (description !== undefined && (typeof description !== "string" || description.length === 0)) {
      fail(
        "SHIP_MAILER_MESSAGE_DESCRIPTION_INVALID",
        `message ${JSON.stringify(name)} description must be a non-empty string when present`,
        mailerId,
        `messages.${name}.description`,
      );
    }
  }
}

function fail(
  code: MailerDefinitionDiagnosticCode,
  message: string,
  mailerId?: string,
  field?: string,
): never {
  throw new InvalidMailerDefinitionError(code, message, { mailerId, field });
}
