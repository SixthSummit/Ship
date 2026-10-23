import { createHash } from "node:crypto";
import type {
  AccessGraphNode,
  AnyChannel,
  AnyModule,
  AnyOperation,
  AttachmentGraphNode,
  CompiledApplication,
  OperationGraphNode,
  RichTextGraphNode,
} from "@sixthsummit/ship-core";
import type {
  ClientContract,
  ClientContractAttachment,
  ClientContractChannel,
  ClientContractMailer,
  ClientContractOperation,
  ClientContractRichText,
  ClientContractRichTextAttr,
  ClientContractStreamResponse,
  ClientContractSuccess,
} from "./manifest.js";
import { projectContractSchema, stableJson } from "./schema.js";

export type {
  ClientContract,
  ClientContractAccess,
  ClientContractAttachment,
  ClientContractCache,
  ClientContractChannel,
  ClientContractChannelScope,
  ClientContractError,
  ClientContractMailer,
  ClientContractOperation,
  ClientContractRichText,
  ClientContractRichTextAttr,
  ClientContractRichTextExtension,
  ClientContractRichTextMark,
  ClientContractRichTextNode,
  ClientContractStreamLimits,
  ClientContractStreamResponse,
  ClientContractSuccess,
  ClientContractTransport,
} from "./manifest.js";

export interface ProjectContractOptions {
  /**
   * Inbound webhook operations are provider-facing, not browser-callable, so
   * the client manifest excludes them (ADR-0009). OpenAPI opts in so the
   * provider-facing endpoint is documented with `x-ship-webhook`.
   */
  readonly includeWebhooks?: boolean;
}

export function projectClientContract<
  const TApp extends CompiledApplication<string, readonly AnyModule[]>,
>(application: TApp, options: ProjectContractOptions = {}): ClientContract {
  const operations = application.graph.operations
    .filter((node) => options.includeWebhooks === true || !isWebhookTransport(node.transport))
    .map((node) => {
      const operation = Reflect.get(application.operationById, node.id) as AnyOperation;
      return projectOperation(operation, node);
    });
  const channels = Object.fromEntries(
    application.modules
      .flatMap((module) => module.channels)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((channel) => [channel.id, projectChannel(channel)]),
  );
  const attachments = Object.fromEntries(
    application.graph.attachments.map((node) => [node.id, projectAttachment(node)]),
  );
  const mailers: Record<string, ClientContractMailer> = Object.fromEntries(
    application.graph.mailers.map((mailer) => [
      mailer.id,
      Object.freeze({ messages: Object.freeze([...mailer.messages]) }),
    ]),
  );
  const richText: Record<string, ClientContractRichText> = Object.fromEntries(
    (application.graph.richText ?? []).map((node) => [node.id, projectRichText(node)]),
  );
  const unsigned = stableJson({
    schemaVersion: 1,
    appId: application.id,
    operations,
    channels,
    attachments,
    ...(Object.keys(mailers).length > 0 ? { mailers } : {}),
    ...(Object.keys(richText).length > 0 ? { richText } : {}),
  });
  const fingerprint = `sha256:${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`;
  return deepFreeze({ ...unsigned, fingerprint }) as unknown as ClientContract;
}

function projectOperation(
  operation: AnyOperation,
  node: OperationGraphNode,
): ClientContractOperation {
  const access: AccessGraphNode = node.access;
  const input = Object.fromEntries(
    Object.entries(operation.input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, schema]) => [
        name,
        projectContractSchema(schema, {
          operationId: operation.id,
          path: `input.${name}`,
          io: "input",
        }),
      ]),
  );
  const success = Object.entries(operation.output)
    .map(([status, schema]) => {
      const numericStatus = Number(status);
      const responseMode = operation.transport?.metadata?.response;
      const projected =
        numericStatus === 204 || numericStatus === 205 || responseMode === "redirect"
          ? { vendor: schema["~standard"].vendor, jsonSchema: {} }
          : responseMode === "binary"
            ? {
                vendor: schema["~standard"].vendor,
                jsonSchema: { type: "string", format: "binary" },
              }
            : projectContractSchema(schema, {
                operationId: operation.id,
                path: `output.${status}`,
                io: "output",
              });
      return Object.freeze({ status: numericStatus, ...projected });
    })
    .sort((left, right) => left.status - right.status);
  const errors = operation.errors
    .map((error) =>
      Object.freeze({
        code: error.code,
        status: error.status,
        message: error.message,
        ...(error.headers ? { headers: [...error.headers] } : {}),
        ...(error.details
          ? {
              details: projectContractSchema(error.details, {
                operationId: operation.id,
                path: `errors.${error.code}.details`,
                io: "output",
              }),
            }
          : {}),
      }),
    )
    .sort((left, right) => left.code.localeCompare(right.code));

  const streamDeclaration = operation.transport?.response;
  return deepFreeze({
    id: operation.id,
    input,
    success,
    errors,
    access,
    transaction: operation.transaction,
    ...(operation.idempotency ? { idempotency: { windowMs: operation.idempotency.windowMs } } : {}),
    ...(node.cache
      ? {
          cache: {
            ttlMs: node.cache.ttlMs,
            scope: node.cache.scope,
            tags: [...node.cache.tags],
            cacheControl: node.cache.cacheControl,
          },
        }
      : {}),
    ...(node.invalidates ? { invalidates: [...node.invalidates] } : {}),
    publishes: operation.publishes.map((channel) => channel.id).sort(),
    ...(node.attachments ? { attachments: [...node.attachments] } : {}),
    ...(node.richText ? { richText: [...node.richText] } : {}),
    ...(operation.transport
      ? {
          transport: {
            kind: operation.transport.kind,
            ...(operation.transport.binding ? { binding: operation.transport.binding } : {}),
            ...(operation.transport.metadata ? { metadata: operation.transport.metadata } : {}),
          },
        }
      : {}),
    ...(streamDeclaration?.mode === "stream"
      ? { response: projectStreamResponse(operation, streamDeclaration, success) }
      : {}),
  }) as unknown as ClientContractOperation;
}

function projectStreamResponse(
  operation: AnyOperation,
  declaration: NonNullable<AnyOperation["transport"]>["response"] & { readonly mode: "stream" },
  success: readonly ClientContractSuccess[],
): ClientContractStreamResponse {
  const { status: _status, ...terminal } = success.find(({ status }) => status === 200) ?? {
    status: 200,
    vendor: "ship",
    jsonSchema: {},
  };
  return {
    mode: "stream",
    framing: declaration.framing as "sse",
    frame: projectContractSchema(declaration.frame, {
      operationId: operation.id,
      path: "transport.response.frame",
      io: "output",
    }),
    terminal,
    limits: {
      heartbeatMs: declaration.heartbeatMs as number,
      maxDurationMs: declaration.maxDurationMs as number,
      maxFrames: declaration.maxFrames as number,
    },
  };
}

/** True when transport metadata carries the kernel's webhook facts. */
export function isWebhookTransport(
  transport: { readonly metadata?: unknown } | undefined,
): boolean {
  const metadata = transport?.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    typeof Reflect.get(metadata, "webhook") === "object" &&
    Reflect.get(metadata, "webhook") !== null
  );
}

function projectChannel(channel: AnyChannel): ClientContractChannel {
  return deepFreeze({
    scope: channel.scope,
    payload: projectContractSchema(channel.payload, {
      channelId: channel.id,
      path: "payload",
      io: "output",
    }),
    presence: channel.presence,
  });
}

/** The upload policy only: never the provider, the key layout or the ledger binding. */
function projectAttachment(node: AttachmentGraphNode): ClientContractAttachment {
  return deepFreeze({
    cardinality: node.cardinality,
    contentTypes: [...node.contentTypes],
    maxBytes: node.maxBytes,
    visibility: node.visibility,
    maxCount: node.maxCount,
    variants: [...node.variants],
  });
}

/** The structural specs only: what the editor needs to agree with the server, never a renderer or validator. */
function projectRichText(node: RichTextGraphNode): ClientContractRichText {
  return deepFreeze({
    schemaVersion: node.schemaVersion,
    ...(node.attachmentId ? { attachment: node.attachmentId } : {}),
    maxBytes: node.maxBytes,
    maxDepth: node.maxDepth,
    extensions: node.extensions.map((extension) => ({
      name: extension.name,
      nodes: Object.fromEntries(
        Object.entries(extension.nodes).map(([name, spec]) => [
          name,
          {
            group: spec.group,
            ...(spec.content !== undefined ? { content: spec.content } : {}),
            ...(spec.atom !== undefined ? { atom: spec.atom } : {}),
            ...(spec.marks !== undefined ? { marks: spec.marks } : {}),
            ...(spec.attrs !== undefined ? { attrs: projectAttrs(spec.attrs) } : {}),
          },
        ]),
      ),
      marks: Object.fromEntries(
        Object.entries(extension.marks).map(([name, spec]) => [
          name,
          { ...(spec.attrs !== undefined ? { attrs: projectAttrs(spec.attrs) } : {}) },
        ]),
      ),
    })),
  });
}

function projectAttrs(
  attrs: Readonly<Record<string, ClientContractRichTextAttr>>,
): Readonly<Record<string, ClientContractRichTextAttr>> {
  return Object.fromEntries(
    Object.entries(attrs).map(([name, spec]) => [
      name,
      {
        type: spec.type,
        ...(spec.required !== undefined ? { required: spec.required } : {}),
        ...(spec.nullable !== undefined ? { nullable: spec.nullable } : {}),
        ...(spec.default !== undefined ? { default: spec.default } : {}),
        ...(spec.enum !== undefined ? { enum: [...spec.enum] } : {}),
        ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
      },
    ]),
  );
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
