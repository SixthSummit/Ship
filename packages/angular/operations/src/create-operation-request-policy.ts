import type { CredentialCapability, CredentialRequest } from './credential-capability';
import type { OperationCallOptions, OperationExecutionOptions } from './operation-client';
import type { RemoteOperationId } from './operation-contract';
import type { OperationExecutionPolicy, OperationPolicyMap } from './operation-policy';
import { OperationPolicyError } from './operation-policy-error';

export interface OperationRequestPolicyConfig<TContract extends object> {
  readonly policies: OperationPolicyMap<TContract>;
  readonly credentials?: CredentialCapability<TContract>;
  readonly baseHeaders?: Readonly<Record<string, string>>;
  readonly requestId?: {
    readonly headerName?: string;
    readonly generate: () => string;
  };
  /** Exact origins allowed to receive prepared operation requests. */
  readonly allowedOrigins?: readonly string[];
  /** Explicit base used only to resolve a relative generated target. Never reads browser globals. */
  readonly baseOrigin?: string;
}

export interface OperationRequestAttempt {
  readonly attempt: number;
  readonly signal: AbortSignal;
  /** Generated absolute or relative transport target, used only for origin enforcement. */
  readonly targetUrl?: string;
}

export interface OperationRequestPolicyCall {
  readonly executionPolicy: OperationExecutionPolicy;
  prepare(attempt: OperationRequestAttempt): Promise<OperationExecutionOptions>;
  refreshAuthentication(status: number, attempt: number, signal: AbortSignal): Promise<boolean>;
}

export interface OperationRequestPolicy<TContract extends object> {
  begin<TId extends RemoteOperationId<TContract>>(
    operation: TId,
    options?: OperationCallOptions
  ): OperationRequestPolicyCall;
}

/** Build the shared header, credential, origin, and refresh policy used by every transport. */
export function createOperationRequestPolicy<TContract extends object>(
  config: OperationRequestPolicyConfig<TContract>
): OperationRequestPolicy<TContract> {
  const allowedOrigins = normalizeAllowedOrigins(config.allowedOrigins);
  return {
    begin: <TId extends RemoteOperationId<TContract>>(
      operation: TId,
      options: OperationCallOptions = {}
    ): OperationRequestPolicyCall => {
      const executionPolicy = config.policies[operation] as OperationExecutionPolicy | undefined;
      if (executionPolicy === undefined) {
        throw new OperationPolicyError(
          `No runtime policy exists for operation: ${operation}`,
          'missing-operation-policy'
        );
      }
      validatePolicy(executionPolicy, options);

      const requestIdHeader = config.requestId?.headerName ?? 'x-request-id';
      if (isCredentialPolicyHeader(requestIdHeader, config.credentials)) {
        throw new OperationPolicyError(
          'Request ID header cannot overlap a credential policy header',
          'sensitive-header'
        );
      }
      const logicalHeaders = mergeCallerHeaders(
        config.baseHeaders,
        options.headers,
        config.credentials
      );
      if (
        readHeader(logicalHeaders, requestIdHeader) === undefined &&
        config.requestId !== undefined
      ) {
        logicalHeaders[requestIdHeader.toLowerCase()] = config.requestId.generate();
      }
      if (options.idempotencyKey !== undefined) {
        logicalHeaders['idempotency-key'] = options.idempotencyKey;
      }

      let authenticationRefreshed = false;
      return {
        executionPolicy,
        prepare: async attempt => {
          assertTargetOrigin(attempt.targetUrl, allowedOrigins, config.baseOrigin);
          return prepareAttempt(
            config.credentials,
            executionPolicy,
            operation,
            attempt.attempt,
            attempt.signal,
            logicalHeaders,
            options
          );
        },
        refreshAuthentication: async (status, attempt, signal) => {
          if (
            status !== 401 ||
            executionPolicy.refreshAuthentication !== true ||
            authenticationRefreshed
          ) {
            return false;
          }
          const credential = config.credentials;
          if (
            credential === undefined ||
            credential.kind === 'anonymous' ||
            credential.refresh === undefined
          ) {
            throw new OperationPolicyError(
              'Operation permits authentication refresh but no refresh capability is configured',
              'missing-refresh-capability'
            );
          }
          try {
            await credential.refresh({ operation, attempt, signal });
          } catch (error: unknown) {
            throw new OperationPolicyError('Credential refresh failed', 'credential-failed', {
              causeName: errorName(error),
            });
          }
          authenticationRefreshed = true;
          return true;
        },
      };
    },
  };
}

function validatePolicy(policy: OperationExecutionPolicy, options: OperationCallOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new OperationPolicyError(
      'Operation timeout must be a positive finite number',
      'invalid-timeout'
    );
  }
  if (policy.authentication === 'anonymous' && policy.csrf === true) {
    throw new OperationPolicyError(
      'Anonymous operations cannot require cookie CSRF policy',
      'csrf-unavailable'
    );
  }
  if (policy.authentication === 'anonymous' && policy.refreshAuthentication === true) {
    throw new OperationPolicyError(
      'Anonymous operations cannot refresh credentials',
      'missing-refresh-capability'
    );
  }
  if (
    policy.retry !== undefined &&
    (!Number.isInteger(policy.retry.maxAttempts) || policy.retry.maxAttempts < 1)
  ) {
    throw new OperationPolicyError(
      'Operation retry maxAttempts must be a positive integer',
      'invalid-retry-policy'
    );
  }
  if (options.idempotencyKey !== undefined && policy.idempotency === 'unsupported') {
    throw new OperationPolicyError(
      'This operation does not support idempotency keys',
      'idempotency-unsupported'
    );
  }
  if (
    policy.idempotency === 'required' &&
    (options.idempotencyKey === undefined || options.idempotencyKey.length === 0)
  ) {
    throw new OperationPolicyError(
      'This operation requires an idempotency key',
      'idempotency-required'
    );
  }
}

async function prepareAttempt<TContract extends object>(
  credential: CredentialCapability<TContract> | undefined,
  policy: OperationExecutionPolicy,
  operation: RemoteOperationId<TContract>,
  attempt: number,
  signal: AbortSignal,
  logicalHeaders: Readonly<Record<string, string>>,
  options: OperationCallOptions
): Promise<OperationExecutionOptions> {
  const headers = { ...logicalHeaders };
  const request: CredentialRequest<TContract> = { operation, attempt, signal };
  let credentials: RequestCredentials | undefined;

  if (policy.authentication === 'anonymous') {
    removeCredentialHeaders(headers, credential);
    credentials = 'omit';
  } else if (credential === undefined || credential.kind === 'anonymous') {
    removeCredentialHeaders(headers, credential);
    credentials = 'omit';
    if (policy.authentication === 'required') {
      throw new OperationPolicyError(
        'Operation requires a credential capability',
        'missing-credential'
      );
    }
  } else if (credential.kind === 'bearer') {
    removeCredentialHeaders(headers, credential);
    credentials = 'omit';
    let token: string | null;
    try {
      token = await credential.getToken(request);
    } catch (error: unknown) {
      throw new OperationPolicyError('Bearer credential supply failed', 'credential-failed', {
        causeName: errorName(error),
      });
    }
    if (token === null) {
      if (policy.authentication === 'required') {
        throw new OperationPolicyError('Operation requires a bearer token', 'missing-credential');
      }
    } else {
      headers[(credential.headerName ?? 'authorization').toLowerCase()] =
        `${credential.scheme ?? 'Bearer'} ${token}`;
    }
    if (policy.csrf === true) {
      throw new OperationPolicyError(
        'CSRF policy requires a cookie credential capability',
        'csrf-unavailable'
      );
    }
  } else {
    delete headers['authorization'];
    credentials = credential.credentials ?? 'include';
    if (policy.csrf === true) {
      if (credential.getCsrfToken === undefined) {
        throw new OperationPolicyError(
          'Operation requires a CSRF token supplier',
          'csrf-unavailable'
        );
      }
      let csrfToken: string | null;
      try {
        csrfToken = await credential.getCsrfToken(request);
      } catch (error: unknown) {
        throw new OperationPolicyError('CSRF token supply failed', 'credential-failed', {
          causeName: errorName(error),
        });
      }
      if (csrfToken === null) {
        throw new OperationPolicyError(
          'Operation requires a current CSRF token',
          'csrf-unavailable'
        );
      }
      headers[(credential.csrfHeaderName ?? 'x-csrf-token').toLowerCase()] = csrfToken;
    }
  }

  return {
    signal,
    headers: Object.freeze(headers),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    attempt,
    ...(credentials === undefined ? {} : { credentials }),
  };
}

function mergeCallerHeaders<TContract extends object>(
  base: Readonly<Record<string, string>> | undefined,
  caller: Readonly<Record<string, string>> | undefined,
  credential: CredentialCapability<TContract> | undefined
): Record<string, string> {
  const headers = normalizeHeaders(base);
  const reserved = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-csrf-token',
    'idempotency-key',
  ]);
  if (credential?.kind === 'bearer') {
    reserved.add((credential.headerName ?? 'authorization').toLowerCase());
  }
  if (credential?.kind === 'cookie') {
    reserved.add((credential.csrfHeaderName ?? 'x-csrf-token').toLowerCase());
  }
  for (const [key, value] of Object.entries(caller ?? {})) {
    const name = key.toLowerCase();
    if (reserved.has(name)) {
      throw new OperationPolicyError(
        `Caller cannot set operation policy header: ${name}`,
        'sensitive-header'
      );
    }
    headers[name] = value;
  }
  return headers;
}

function removeCredentialHeaders<TContract extends object>(
  headers: Record<string, string>,
  credential: CredentialCapability<TContract> | undefined
): void {
  delete headers['authorization'];
  delete headers['cookie'];
  delete headers['x-csrf-token'];
  if (credential?.kind === 'bearer') {
    delete headers[(credential.headerName ?? 'authorization').toLowerCase()];
  }
  if (credential?.kind === 'cookie') {
    delete headers[(credential.csrfHeaderName ?? 'x-csrf-token').toLowerCase()];
  }
}

function isCredentialPolicyHeader<TContract extends object>(
  name: string,
  credential: CredentialCapability<TContract> | undefined
): boolean {
  const normalized = name.toLowerCase();
  if (
    ['authorization', 'cookie', 'set-cookie', 'x-csrf-token', 'idempotency-key'].includes(
      normalized
    )
  ) {
    return true;
  }
  if (credential?.kind === 'bearer') {
    return normalized === (credential.headerName ?? 'authorization').toLowerCase();
  }
  if (credential?.kind === 'cookie') {
    return normalized === (credential.csrfHeaderName ?? 'x-csrf-token').toLowerCase();
  }
  return false;
}

function normalizeHeaders(
  source: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function readHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

function normalizeAllowedOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  try {
    return new Set((origins ?? []).map(origin => new URL(origin).origin));
  } catch {
    throw new OperationPolicyError(
      'Allowed operation origins must be absolute URLs',
      'target-origin'
    );
  }
}

function assertTargetOrigin(
  targetUrl: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  baseOrigin: string | undefined
): void {
  if (allowedOrigins.size === 0) return;
  if (targetUrl === undefined) {
    throw new OperationPolicyError(
      'Operation target is required when allowed origins are configured',
      'target-origin'
    );
  }
  let target: URL;
  try {
    target = baseOrigin === undefined ? new URL(targetUrl) : new URL(targetUrl, baseOrigin);
  } catch {
    throw new OperationPolicyError('Operation target URL is invalid', 'target-origin');
  }
  if (!allowedOrigins.has(target.origin)) {
    throw new OperationPolicyError(
      'Operation target origin is not approved by request policy',
      'target-origin'
    );
  }
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'UnknownError';
  return typeof error.name === 'string' && error.name.length > 0 ? error.name : 'UnknownError';
}
