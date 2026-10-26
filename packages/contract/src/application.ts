/** Backend-only type projection from a compiled app to the neutral client seam. */
import type {
  AnyChannel,
  AnyModule,
  CompiledApplication,
  InferSchemaOutput,
  OperationExecutionResult,
  OperationId,
  OperationRawInput,
  ProjectableRuntimeSchema,
  RuntimeSchema,
} from "@sixthsummit/ship-core";

type OperationFromApp<
  TApp extends CompiledApplication<string, readonly AnyModule[]>,
  TId extends OperationId<TApp>,
> = TApp["operationById"][TId];

type TransportFromOperation<TOperation> = TOperation extends {
  readonly transport?: infer TTransport;
}
  ? TTransport
  : never;

type StreamFromOperation<TOperation> = TOperation extends {
  readonly transport?: infer TTransport;
  readonly output: { readonly 200: infer TTerminal extends RuntimeSchema };
}
  ? TTransport extends {
      readonly response: {
        readonly mode: "stream";
        readonly frame: infer TFrame extends RuntimeSchema;
      };
    }
    ? {
        readonly stream: {
          readonly frame: InferSchemaOutput<TFrame>;
          readonly terminal: InferSchemaOutput<TTerminal>;
        };
      }
    : { readonly stream?: undefined }
  : { readonly stream?: undefined };

type IsWebhookTransport<TTransport> = [TTransport] extends [undefined]
  ? false
  : NonNullable<TTransport> extends { readonly metadata: { readonly webhook: unknown } }
    ? true
    : false;

/** Inbound webhook operations are provider-facing and never part of the client contract. */
type WebhookOperationIds<TApp extends CompiledApplication<string, readonly AnyModule[]>> = {
  [TId in OperationId<TApp>]: IsWebhookTransport<
    TransportFromOperation<OperationFromApp<TApp, TId>>
  > extends true
    ? TId
    : never;
}[OperationId<TApp>];

/**
 * The type a channel payload takes in the contract when the manifest cannot
 * derive JSON Schema from it: neither a natively projected vendor (Zod v4)
 * nor a `ProjectableRuntimeSchema`. It names the channel so the fix is one
 * `contractSchema()` away, and it is assignable to nothing a client expects,
 * so the gap fails type-checking instead of the manifest build.
 */
export interface ChannelPayloadNotProjectable<TChannelId extends string = string> {
  readonly "~ship.contract.error": `channel ${TChannelId} payload has no client-manifest projection; declare it with a Zod v4 schema or wrap it with contractSchema()`;
}

/** Zod v4 schemas expose `_zod`; the manifest projects them without declared metadata. */
type NativelyProjectedSchema = RuntimeSchema & { readonly _zod: unknown };

export type ChannelPayloadOf<TChannel extends AnyChannel> = TChannel["payload"] extends
  | ProjectableRuntimeSchema
  | NativelyProjectedSchema
  ? InferSchemaOutput<TChannel["payload"]>
  : ChannelPayloadNotProjectable<TChannel["id"]>;

type ChannelUnion<TApp extends CompiledApplication<string, readonly AnyModule[]>> =
  TApp["modules"][number]["channels"][number];

/** Every declared channel keyed by id, mirroring `ClientContract["channels"]` with payload types. */
export type ApplicationChannelsOf<TApp extends CompiledApplication<string, readonly AnyModule[]>> =
  {
    readonly [TChannel in ChannelUnion<TApp> as TChannel["id"]]: {
      readonly scope: TChannel["scope"];
      readonly payload: ChannelPayloadOf<TChannel>;
      readonly presence: TChannel["presence"];
    };
  };

type AttachmentUnion<TApp extends CompiledApplication<string, readonly AnyModule[]>> =
  TApp["modules"][number]["attachments"][number];

/**
 * Every declared attachment keyed by id, mirroring `ClientContract["attachments"]`.
 * A module that widened its attachments to `readonly AnyAttachment[]` contributes
 * no key: a `string` id would otherwise swallow every literal one.
 */
export type ApplicationAttachmentsOf<
  TApp extends CompiledApplication<string, readonly AnyModule[]>,
> = {
  readonly [TAttachment in AttachmentUnion<TApp> as string extends TAttachment["id"]
    ? never
    : TAttachment["id"]]: {
    readonly cardinality: TAttachment["cardinality"];
    readonly visibility: TAttachment["visibility"];
    readonly variants: Extract<keyof TAttachment["variants"], string>;
  };
};

export type ApplicationContractOf<TApp extends CompiledApplication<string, readonly AnyModule[]>> =
  {
    readonly channels: ApplicationChannelsOf<TApp>;
    readonly attachments: ApplicationAttachmentsOf<TApp>;
    readonly operations: {
      readonly [TId in Exclude<OperationId<TApp>, WebhookOperationIds<TApp>>]: {
        readonly transport: Extract<
          TransportFromOperation<OperationFromApp<TApp, TId>>,
          { readonly kind: string }
        > extends { readonly kind: infer TKind extends string }
          ? TKind
          : "direct";
        readonly input: OperationRawInput<OperationFromApp<TApp, TId>>;
        readonly result: OperationExecutionResult<OperationFromApp<TApp, TId>>;
      } & StreamFromOperation<OperationFromApp<TApp, TId>>;
    };
  };
