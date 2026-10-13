import type {
  DeclaredResultOf,
  ErrorCodeOf,
  OperationId,
  SuccessMapOf,
} from './operation-contract';
import type { ResponseMetadata } from './response-metadata';
import type { ShipError } from './ship-error';

export interface OperationSuccess<TData, TStatus extends number = number> {
  readonly ok: true;
  readonly notModified?: false;
  readonly status: TStatus;
  readonly data: TData;
  readonly headers: ResponseMetadata;
}

/** HTTP cache revalidation result. The previously typed value lives in the resource cache. */
export interface OperationNotModified {
  readonly ok: true;
  readonly notModified: true;
  readonly status: 304;
  readonly headers: ResponseMetadata;
}

export interface OperationFailure<TCode extends string = string, TStatus extends number = number> {
  readonly ok: false;
  readonly status: TStatus;
  readonly error: ShipError<TCode>;
  readonly headers: ResponseMetadata;
}

/** Lossless expected result for one operation call. */
export type OperationResult<TData, TCode extends string = string, TStatus extends number = number> =
  | OperationSuccess<TData, TStatus>
  | OperationFailure<TCode>;

type NormalizeStatus<TKey> = TKey extends number
  ? TKey
  : TKey extends `${infer TStatus extends number}`
    ? TStatus
    : never;

type SuccessResultFromMap<TSuccess extends object> = {
  [TKey in keyof TSuccess]: TKey extends number | `${number}`
    ? OperationSuccess<TSuccess[TKey], NormalizeStatus<TKey>>
    : never;
}[keyof TSuccess];

type NormalizeDeclaredResult<TResult> = TResult extends {
  readonly ok: true;
  readonly status: infer TStatus extends number;
  readonly data: infer TData;
}
  ? OperationSuccess<TData, TStatus>
  : TResult extends {
        readonly ok: false;
        readonly status: infer TStatus extends number;
        readonly error: { readonly code: infer TCode extends string };
      }
    ? OperationFailure<TCode, TStatus>
    : never;

type FrameworkOperationFailure =
  | OperationFailure<'VALIDATION_ERROR', 400>
  | OperationFailure<'AUTHENTICATION_ERROR', 401>
  | OperationFailure<'AUTHORIZATION_ERROR', 403>
  | OperationFailure<'IDEMPOTENT_IN_FLIGHT', 409>
  | OperationFailure<'PAYLOAD_TOO_LARGE', 413>
  | OperationFailure<'UNSUPPORTED_MEDIA_TYPE', 415>
  | OperationFailure<'INTERNAL_SERVER_ERROR', 500>
  | OperationFailure<'AUTHENTICATION_UNAVAILABLE', 503>;

type CanonicalOperationResultOf<TContract extends object, TId extends OperationId<TContract>> =
  | NormalizeDeclaredResult<DeclaredResultOf<TContract, TId>>
  | FrameworkOperationFailure
  | OperationNotModified;

/** Status-indexed result union inferred from a client-safe application contract. */
export type OperationResultOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = TContract extends { readonly operations: object }
  ? CanonicalOperationResultOf<TContract, TId>
  :
      | SuccessResultFromMap<SuccessMapOf<TContract, TId>>
      | OperationNotModified
      | OperationFailure<ErrorCodeOf<TContract, TId>>;

/** Successful result branches inferred from an operation. */
export type OperationSuccessOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = Extract<OperationResultOf<TContract, TId>, { readonly ok: true }>;

/** Successful result branches that carry a decoded response body. */
export type OperationDataSuccessOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = Exclude<OperationSuccessOf<TContract, TId>, OperationNotModified>;

/** Decoded body union inferred from every declared success status. */
export type OperationDataOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = OperationDataSuccessOf<TContract, TId>['data'];

/** Declared success status union for one operation. */
export type OperationSuccessStatusOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = OperationDataSuccessOf<TContract, TId>['status'];

/** Failed result branch inferred from an operation. */
export type OperationFailureOf<
  TContract extends object,
  TId extends OperationId<TContract>,
> = Extract<OperationResultOf<TContract, TId>, { readonly ok: false }>;
