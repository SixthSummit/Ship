/** Transport categories exposed by a client-safe ShipAPI contract. */
export type OperationTransport = 'http' | 'upload' | 'download' | 'stream' | 'socket';

/** Framework failures added by ShipAPI's default client to every HTTP operation. */
export type FrameworkOperationErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'IDEMPOTENT_IN_FLIGHT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_SERVER_ERROR'
  | 'AUTHENTICATION_UNAVAILABLE';

/** Neutral operation type emitted by ShipAPI's application-specific client package. */
export interface OperationTypeDefinition<
  TInput = unknown,
  TResult extends { readonly ok: boolean; readonly status: number } = {
    readonly ok: boolean;
    readonly status: number;
  },
  TTransport extends string = string,
> {
  readonly transport: TTransport;
  readonly input: TInput;
  readonly result: TResult;
}

/** Canonical generated type package shape implemented by ShipAPI. */
export interface OperationTypeContract<
  TOperations extends Readonly<Record<string, OperationTypeDefinition>> = Readonly<
    Record<string, OperationTypeDefinition>
  >,
> {
  readonly operations: TOperations;
}

/**
 * Structural shape of one generated operation declaration.
 *
 * Applications normally receive this shape from ShipAPI generation. The generic
 * parameters exist so fixtures and third-party structural clients can implement the
 * same boundary without importing a ShipAPI runtime package.
 */
export interface OperationDefinition<
  TInput = unknown,
  TSuccess extends object = Record<number, unknown>,
  TErrors extends string = string,
  TTransport extends OperationTransport = 'http',
> {
  readonly input: TInput;
  readonly success: TSuccess;
  readonly errors: TErrors;
  readonly transport: TTransport;
}

/** Select the operation map from the canonical package shape or the temporary flat fixture shape. */
export type OperationMapOf<TContract extends object> = TContract extends {
  readonly operations: infer TOperations extends object;
}
  ? TOperations
  : TContract;

/** Stable string operation IDs declared by an application contract. */
export type OperationId<TContract extends object> = Extract<
  keyof OperationMapOf<TContract>,
  string
>;

/** One operation declaration selected from an application contract. */
export type OperationOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = OperationMapOf<TContract>[TId] extends {
  readonly input: unknown;
  readonly transport: string;
}
  ? OperationMapOf<TContract>[TId]
  : never;

/** Input locations and values accepted by an operation. */
export type InputOf<TContract extends object, TId extends OperationId<TContract>> = OperationOf<
  TContract,
  TId
>['input'];

/** Declared application error codes for an operation. */
export type ErrorCodeOf<TContract extends object, TId extends OperationId<TContract>> =
  OperationOf<TContract, TId> extends { readonly errors: infer TCode extends string }
    ? TCode
    : OperationOf<TContract, TId> extends { readonly result: infer TResult }
      ?
          | ErrorCodeFromResult<TResult>
          | (TContract extends { readonly operations: object }
              ? FrameworkOperationErrorCode
              : never)
      : never;

/** Transport category for an operation. */
export type TransportOf<TContract extends object, TId extends OperationId<TContract>> = OperationOf<
  TContract,
  TId
>['transport'];

/** Stable operation IDs selected by their explicit transport capability. */
export type OperationIdForTransport<TContract extends object, TTransport extends string> = {
  [TId in OperationId<TContract>]: TransportOf<TContract, TId> extends TTransport ? TId : never;
}[OperationId<TContract>];

/** Unary HTTP operations; ShipAPI stream responses retain an HTTP transport declaration. */
export type HttpOperationId<TContract extends object> = {
  [TId in OperationId<TContract>]: TransportOf<TContract, TId> extends 'http'
    ? OperationOf<TContract, TId> extends { readonly stream: { readonly frame: unknown } }
      ? never
      : TId
    : never;
}[OperationId<TContract>];
export type UploadOperationId<TContract extends object> = OperationIdForTransport<
  TContract,
  'upload'
>;
export type DownloadOperationId<TContract extends object> = OperationIdForTransport<
  TContract,
  'download'
>;
/** Explicit stream transports and ShipAPI HTTP operations with stream responses. */
export type StreamOperationId<TContract extends object> = {
  [TId in OperationId<TContract>]: TransportOf<TContract, TId> extends 'stream'
    ? TId
    : OperationOf<TContract, TId> extends { readonly stream: { readonly frame: unknown } }
      ? TId
      : never;
}[OperationId<TContract>];
export type SocketOperationId<TContract extends object> = OperationIdForTransport<
  TContract,
  'socket'
>;
export type RemoteOperationId<TContract extends object> =
  | HttpOperationId<TContract>
  | UploadOperationId<TContract>
  | DownloadOperationId<TContract>
  | StreamOperationId<TContract>
  | SocketOperationId<TContract>;

/** Status-indexed successful response body map for an operation. */
export type SuccessMapOf<TContract extends object, TId extends OperationId<TContract>> =
  OperationOf<TContract, TId> extends { readonly success: infer TSuccess extends object }
    ? TSuccess
    : OperationOf<TContract, TId> extends { readonly result: infer TResult }
      ? SuccessMapFromResult<TResult>
      : never;

/** Raw result union emitted for one canonical ShipAPI operation type. */
export type DeclaredResultOf<TContract extends object, TId extends OperationId<TContract>> =
  OperationOf<TContract, TId> extends { readonly result: infer TResult } ? TResult : never;

type ErrorCodeFromResult<TResult> = TResult extends {
  readonly ok: false;
  readonly error: { readonly code: infer TCode extends string };
}
  ? TCode
  : never;

type SuccessStatusFromResult<TResult> = TResult extends {
  readonly ok: true;
  readonly status: infer TStatus extends number;
}
  ? TStatus
  : never;

type DataForStatus<TResult, TStatus extends number> =
  Extract<TResult, { readonly ok: true; readonly status: TStatus }> extends infer TSuccess
    ? TSuccess extends { readonly data: infer TData }
      ? TData
      : undefined
    : never;

type SuccessMapFromResult<TResult> = {
  readonly [TStatus in SuccessStatusFromResult<TResult>]: DataForStatus<TResult, TStatus>;
};
