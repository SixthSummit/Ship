import type { FromSchema, JSONSchema } from "json-schema-to-ts";
import type {
  ClientContract,
  ClientContractChannel,
  ClientContractError,
  ClientContractOperation,
  ClientContractSuccess,
  ProjectedContractSchema,
} from "./manifest.js";

type SchemaValue<TSchema> = TSchema extends ProjectedContractSchema
  ? TSchema["jsonSchema"] extends infer TJsonSchema extends JSONSchema
    ? FromSchema<TJsonSchema>
    : unknown
  : unknown;

type OperationInput<TOperation extends ClientContractOperation> = Readonly<{
  [TLocation in keyof TOperation["input"]]: TLocation extends "body"
    ? TOperation extends {
        readonly transport: {
          readonly kind: "http";
          readonly metadata: { readonly requestBody: { readonly mode: "multipart" } };
        };
      }
      ? FormData
      : SchemaValue<TOperation["input"][TLocation]>
    : SchemaValue<TOperation["input"][TLocation]>;
}>;

type SuccessResult<
  TSuccess extends ClientContractSuccess,
  TOperation extends ClientContractOperation,
> = TSuccess extends unknown
  ? Readonly<{
      ok: true;
      status: TSuccess["status"];
      data: TSuccess["status"] extends 204 | 205 | 301 | 302 | 303 | 307 | 308
        ? undefined
        : TOperation extends {
              readonly transport: {
                readonly kind: "http";
                readonly metadata: { readonly response: "binary" };
              };
            }
          ? Uint8Array
          : SchemaValue<TSuccess>;
    }>
  : never;

type ErrorPayload<TError extends ClientContractError> = Readonly<{
  code: TError["code"];
  message: string;
}> &
  (TError extends { readonly details: ProjectedContractSchema }
    ? Readonly<{ details: SchemaValue<TError["details"]> }>
    : Readonly<{ details?: unknown }>);

type FailureResult<TError extends ClientContractError> = TError extends unknown
  ? Readonly<{
      ok: false;
      status: TError["status"];
      error: ErrorPayload<TError>;
    }>
  : never;

type OperationTransport<TOperation extends ClientContractOperation> = TOperation extends {
  readonly transport: { readonly kind: infer TKind extends string };
}
  ? TKind
  : "direct";

type OperationStreamType<TOperation extends ClientContractOperation> = TOperation extends {
  readonly response: {
    readonly mode: "stream";
    readonly frame: infer TFrame extends ProjectedContractSchema;
  };
}
  ? Readonly<{
      stream: Readonly<{
        frame: SchemaValue<TFrame>;
        terminal: TOperation extends {
          readonly response: { readonly terminal: infer TTerminal extends ProjectedContractSchema };
        }
          ? SchemaValue<TTerminal>
          : undefined;
      }>;
    }>
  : unknown;

type OperationType<TOperation extends ClientContractOperation> = Readonly<{
  transport: OperationTransport<TOperation>;
  input: OperationInput<TOperation>;
  result:
    | SuccessResult<TOperation["success"][number], TOperation>
    | FailureResult<TOperation["errors"][number]>;
}> &
  OperationStreamType<TOperation>;

type OperationById<
  TContract extends ClientContract,
  TId extends TContract["operations"][number]["id"],
> = Extract<TContract["operations"][number], { readonly id: TId }>;

/**
 * Derives the browser-safe structural operation type from a literal client manifest.
 *
 * `ship-api contract` emits the manifest with `as const`, preserving operation IDs,
 * statuses, error codes, and JSON Schemas for this projection. The dependency on
 * `json-schema-to-ts` is type-only and adds no browser runtime code.
 */
export type ClientTypeContract<TContract extends ClientContract> = Readonly<{
  operations: Readonly<{
    [TId in TContract["operations"][number]["id"]]: OperationType<OperationById<TContract, TId>>;
  }>;
  channels: Readonly<{
    [TId in keyof NonNullable<TContract["channels"]>]: ChannelType<
      NonNullable<TContract["channels"]>[TId]
    >;
  }>;
}>;

type ChannelType<TChannel extends ClientContractChannel> = Readonly<{
  scope: TChannel["scope"];
  payload: SchemaValue<TChannel["payload"]>;
  presence: TChannel["presence"];
}>;
