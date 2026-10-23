import {
  type HttpOperationId,
  type InputOf,
  type OperationExecutionOptions,
  type OperationExecutor,
  type OperationResultOf,
  type OperationTypeContract,
  ProtocolError,
  parseRetryAfterMs,
  type ResponseMetadata,
  type ShipError,
  TransportError,
} from '@sixthsummit/ship-angular/operations';
import type { OperationClient as ShipApiOperationClient } from '@sixthsummit/ship-contract/client';

/** Browser-safe subset of ShipAPI's generated JSON client manifest used for error classification. */
export interface ShipApiClientContractManifest {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly operations: readonly {
    readonly id: string;
    /** ShipAPI marks stream responses inside the HTTP transport. They use a separate adapter. */
    readonly transport?: {
      readonly kind: string;
      readonly metadata?: { readonly response?: string };
    };
    readonly success: readonly { readonly status: number }[];
    readonly errors: readonly { readonly code: string; readonly status: number }[];
  }[];
}

/** Metadata returned by the current structural ShipAPI HTTP client. */
export interface ShipApiClientMetadata {
  readonly requestId?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly retryAfter?: string;
  readonly etag?: string;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly location?: string;
}

export type ShipApiClientResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly data?: unknown;
      readonly requestId?: string;
      readonly metadata: ShipApiClientMetadata;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
        readonly requestId?: string;
      };
      readonly requestId?: string;
      readonly metadata: ShipApiClientMetadata;
    };

/** Canonical ShipAPI client signature; the dependency is erased from the runtime bundle. */
export type { ShipApiOperationClient };

export interface ShipApiClientFactoryContext {
  /** Credential mode selected independently for this operation by ShipAngular's policy. */
  readonly credentials: RequestCredentials;
}

export type ShipApiOperationClientFactory<TContract extends OperationTypeContract> = (
  context: ShipApiClientFactoryContext
) => ShipApiOperationClient<TContract>;

export interface ShipApiClientExecutorOptions {
  /** Deterministic metadata clock for Retry-After HTTP-date parsing. */
  readonly now?: () => number;
}

const FRAMEWORK_ERRORS = new Map<string, number>([
  ['VALIDATION_ERROR', 400],
  ['AUTHENTICATION_ERROR', 401],
  ['AUTHORIZATION_ERROR', 403],
  ['IDEMPOTENT_IN_FLIGHT', 409],
  ['PAYLOAD_TOO_LARGE', 413],
  ['UNSUPPORTED_MEDIA_TYPE', 415],
  ['INTERNAL_SERVER_ERROR', 500],
  ['AUTHENTICATION_UNAVAILABLE', 503],
]);

/**
 * Adapt ShipAPI's current structural HTTP client into ShipAngular's policy executor.
 *
 * ShipAPI currently fixes `credentials` when a client is constructed, while ShipAngular
 * selects credential mode per operation. The factory is therefore cached once per mode;
 * anonymous and cookie calls can never accidentally share a credential configuration.
 */
export function createShipApiClientExecutor<TContract extends OperationTypeContract>(
  manifest: ShipApiClientContractManifest,
  createClient: ShipApiOperationClientFactory<TContract>,
  options: ShipApiClientExecutorOptions = {}
): OperationExecutor<TContract> {
  const declarations = indexDeclarations(manifest);
  const clients = new Map<RequestCredentials, ShipApiOperationClient<TContract>>();

  return {
    call: async <TId extends HttpOperationId<TContract>>(
      operation: TId,
      input: InputOf<TContract, TId>,
      execution: OperationExecutionOptions
    ): Promise<OperationResultOf<TContract, TId>> => {
      const declaration = declarations.get(operation);
      if (declaration === undefined) {
        throw new ProtocolError('Operation is absent from the ShipAPI client manifest', {
          reason: 'invalid-envelope',
        });
      }
      if (declaration.stream) {
        throw new ProtocolError('Stream operations require a stream adapter', {
          reason: 'invalid-envelope',
        });
      }
      const credentials = execution.credentials ?? 'omit';
      let client = clients.get(credentials);
      if (client === undefined) {
        client = createClient({ credentials });
        clients.set(credentials, client);
      }

      let received: unknown;
      try {
        // The public factory is checked against ShipAPI's exact generic call type. This
        // localized invocation crosses from ShipAngular's unary policy types into that
        // client; the manifest and result checks below enforce the runtime boundary.
        const invoke = client as {
          call: (
            operationId: string,
            input: unknown,
            options: {
              readonly signal?: AbortSignal;
              readonly headers?: Readonly<Record<string, string>>;
              readonly idempotencyKey?: string;
              readonly keepalive?: boolean;
            }
          ) => unknown;
        };
        const pending = invoke.call(operation, input, {
          signal: execution.signal,
          ...(execution.headers === undefined ? {} : { headers: execution.headers }),
          ...(execution.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: execution.idempotencyKey }),
          ...(execution.keepalive === undefined ? {} : { keepalive: execution.keepalive }),
        });
        if (!isPromiseLike(pending)) {
          throw new ProtocolError('ShipAPI unary client returned a non-Promise value', {
            reason: 'invalid-envelope',
          });
        }
        received = await pending;
      } catch (error: unknown) {
        if (isRecord(error) && Reflect.get(error, 'code') === 'SHIP_CLIENT_REDIRECT_OPAQUE') {
          throw new ProtocolError('The browser hid the declared redirect; navigate instead', {
            reason: 'opaque-redirect',
          });
        }
        if (error instanceof ProtocolError || isShipApiClientError(error) || isAbortError(error)) {
          throw error;
        }
        throw new TransportError('The ShipAPI operation transport failed', {
          causeName: errorName(error),
        });
      }
      const result = assertShipApiClientResult(received);

      const metadata = normalizeMetadata(result, options.now?.() ?? Date.now());
      if (result.ok === true) {
        if (result.status === 304) {
          return {
            ok: true,
            notModified: true,
            status: 304,
            headers: metadata,
          } as OperationResultOf<TContract, TId>;
        }
        if (!declaration.success.has(result.status)) {
          throw new ProtocolError('ShipAPI client returned an undeclared success status', {
            reason: 'unexpected-status',
            status: result.status,
            metadata,
          });
        }
        return {
          ok: true,
          status: result.status,
          data: result.data,
          headers: metadata,
        } as OperationResultOf<TContract, TId>;
      }
      if (!isShipApiClientFailure(result)) {
        throw new ProtocolError('ShipAPI client result has an invalid discriminant', {
          reason: 'invalid-envelope',
        });
      }

      const declared =
        declaration.errors.has(`${result.status}:${result.error.code}`) ||
        FRAMEWORK_ERRORS.get(result.error.code) === result.status;
      const extensions = withoutKeys(result.error, ['code', 'message', 'details', 'requestId']);
      const envelopeExtensions = withoutKeys(result, [
        'ok',
        'status',
        'error',
        'requestId',
        'metadata',
      ]);
      const common = {
        code: result.error.code,
        message: result.error.message,
        requestId: result.error.requestId ?? result.requestId ?? metadata.requestId,
        ...(result.error.details === undefined ? {} : { details: result.error.details }),
        ...(extensions === undefined ? {} : { extensions }),
        ...(envelopeExtensions === undefined ? {} : { envelopeExtensions }),
      };
      const error: ShipError = declared
        ? { ...common, declared: true }
        : { ...common, declared: false };
      return {
        ok: false,
        status: result.status,
        error,
        headers: metadata,
      } as OperationResultOf<TContract, TId>;
    },
  };
}

function isShipApiClientFailure(
  result: ShipApiClientResult
): result is Extract<ShipApiClientResult, { readonly ok: false }> {
  return result.ok === false;
}

function assertShipApiClientResult(value: unknown): ShipApiClientResult {
  if (
    !isRecord(value) ||
    typeof value['ok'] !== 'boolean' ||
    !Number.isInteger(value['status']) ||
    (value['status'] as number) < 100 ||
    (value['status'] as number) > 599
  ) {
    throw new ProtocolError('ShipAPI client returned an invalid operation result', {
      reason: 'invalid-envelope',
    });
  }
  if (
    value['ok'] === false &&
    (!isRecord(value['error']) ||
      typeof value['error']['code'] !== 'string' ||
      value['error']['code'].length === 0 ||
      typeof value['error']['message'] !== 'string')
  ) {
    throw new ProtocolError('ShipAPI client returned an invalid error result', {
      reason: 'invalid-envelope',
      status: value['status'] as number,
    });
  }
  return value as unknown as ShipApiClientResult;
}

function indexDeclarations(manifest: ShipApiClientContractManifest): ReadonlyMap<
  string,
  {
    readonly success: ReadonlySet<number>;
    readonly errors: ReadonlySet<string>;
    readonly stream: boolean;
  }
> {
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.appId !== 'string' ||
    manifest.appId.length === 0 ||
    typeof manifest.fingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.fingerprint) ||
    !Array.isArray(manifest.operations)
  ) {
    throw new ProtocolError('ShipAPI client manifest is invalid', {
      reason: 'invalid-envelope',
    });
  }
  const declarations = new Map<
    string,
    {
      readonly success: ReadonlySet<number>;
      readonly errors: ReadonlySet<string>;
      readonly stream: boolean;
    }
  >();
  for (const operation of manifest.operations) {
    if (
      typeof operation?.id !== 'string' ||
      operation.id.length === 0 ||
      !Array.isArray(operation.success) ||
      !Array.isArray(operation.errors) ||
      declarations.has(operation.id)
    ) {
      throw new ProtocolError('ShipAPI client manifest contains an invalid operation', {
        reason: 'invalid-envelope',
      });
    }
    const success = new Set<number>();
    for (const response of operation.success) {
      if (!Number.isInteger(response?.status) || success.has(response.status)) {
        throw new ProtocolError('ShipAPI client manifest contains an invalid success declaration', {
          reason: 'invalid-envelope',
        });
      }
      success.add(response.status);
    }
    const errors = new Set<string>();
    for (const error of operation.errors) {
      if (
        typeof error?.code !== 'string' ||
        error.code.length === 0 ||
        !Number.isInteger(error.status)
      ) {
        throw new ProtocolError('ShipAPI client manifest contains an invalid error declaration', {
          reason: 'invalid-envelope',
        });
      }
      errors.add(`${error.status}:${error.code}`);
    }
    declarations.set(operation.id, {
      success,
      errors,
      stream: operation.transport?.metadata?.response === 'stream',
    });
  }
  return declarations;
}

function normalizeMetadata(
  result: ShipApiClientResult,
  now: number
): ResponseMetadata & { readonly requestId: string } {
  const metadata = result.metadata;
  if (!isRecord(metadata) || !isStringRecord(metadata.headers)) {
    throw new ProtocolError('ShipAPI client result contains invalid response metadata', {
      reason: 'invalid-envelope',
      status: result.status,
    });
  }
  const headers = Object.freeze(
    Object.fromEntries(
      Object.entries(metadata.headers)
        .map(([name, value]) => [name.toLowerCase(), value] as const)
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );
  const requestId = result.requestId ?? metadata.requestId ?? headers['x-request-id'];
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new ProtocolError('ShipAPI client result is missing its request ID', {
      reason: 'invalid-envelope',
      status: result.status,
    });
  }
  const retryAfter = metadata.retryAfter ?? headers['retry-after'];
  const replayed = headers['idempotency-replayed'];
  const retryAfterMs = parseRetryAfterMs(retryAfter ?? null, now);
  const etag = metadata.etag ?? headers['etag'];
  const contentType = metadata.contentType ?? headers['content-type'];
  const contentDisposition = metadata.contentDisposition ?? headers['content-disposition'];
  const location = metadata.location ?? headers['location'];
  const idempotencyKey = headers['idempotency-key'];
  const idempotencyResult = headers['idempotency-result'];
  return {
    headers,
    requestId,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(etag === undefined ? {} : { etag }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentDisposition === undefined ? {} : { contentDisposition }),
    ...(location === undefined ? {} : { location }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(replayed === undefined ? {} : { idempotencyReplayed: replayed === 'true' }),
    ...(idempotencyResult === undefined ? {} : { idempotencyResult }),
  };
}

function isShipApiClientError(value: unknown): value is Error & { readonly code: string } {
  return (
    isRecord(value) &&
    typeof Reflect.get(value, 'code') === 'string' &&
    (Reflect.get(value, 'code') as string).startsWith('SHIP_CLIENT_')
  );
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && Reflect.get(value, 'name') === 'AbortError';
}

function errorName(value: unknown): string {
  const name = isRecord(value) ? Reflect.get(value, 'name') : undefined;
  return typeof name === 'string' && name.length > 0 ? name : 'UnknownError';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (isRecord(value) || typeof value === 'function') &&
    typeof Reflect.get(value, 'then') === 'function'
  );
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function withoutKeys(
  value: object,
  excluded: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  const entries = Object.entries(value).filter(([key]) => !excluded.includes(key));
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
}
