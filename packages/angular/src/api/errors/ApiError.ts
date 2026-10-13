/**
 * Typed JS class for ShipAPI's structured error envelope.
 *
 * ShipAPI v4 (Hono + AppError taxonomy) responds to errors with:
 *
 * ```json
 * {
 *   "success": false,
 *   "error": { "code": "AUTHENTICATION_ERROR", "message": "...", "details": {...} }
 * }
 * ```
 *
 * Components and services switch on `error.code` (durable string codes from
 * the server's `AppError` taxonomy). Use `instanceof ApiError` to discriminate
 * structured backend errors from network / parse failures, then read `.code`,
 * `.message`, `.details`, and `.status` for handling logic.
 *
 * The constructor accepts the raw envelope + HTTP status; static factories
 * (`fromResponse`, `fromEnvelope`) cover the common building paths from a
 * `fetch` response or a parsed JSON body.
 */

/**
 * Wire shape of the ShipAPI error response. Apps that read response bodies
 * before this class wraps them can use this type for narrowing.
 */
export interface ApiErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
  /** Stack trace — present only when the server runs in development mode. */
  readonly stack?: string;
  /** Original error class name — present only when the server runs in development mode. */
  readonly name?: string;
}

/**
 * Catalogue of error codes ShipAPI's framework taxonomy ships out of the box.
 * Apps that define custom error codes are not constrained to this set —
 * `ApiError.code` is `string`, not this constant.
 */
export const ApiErrorCode = {
  Authentication: 'AUTHENTICATION_ERROR',
  Authorization: 'AUTHORIZATION_ERROR',
  Validation: 'VALIDATION_ERROR',
  NotFound: 'NOT_FOUND_ERROR',
  BadRequest: 'BAD_REQUEST_ERROR',
  Conflict: 'CONFLICT_ERROR',
  RateLimitExceeded: 'RATE_LIMIT_EXCEEDED',
  Internal: 'INTERNAL_SERVER_ERROR',
  Unavailable: 'SERVICE_UNAVAILABLE_ERROR',
} as const;
export type ApiErrorCodeName = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/**
 * Structured error class for backend responses that follow ShipAPI's
 * envelope. Use `instanceof ApiError` to discriminate from network errors
 * and switch on `.code` to handle specific server conditions.
 *
 * @example
 * ```ts
 * try {
 *   const res = await api.posts.$post({ json: { title } });
 *   if (!res.ok) throw await ApiError.fromResponse(res);
 *   return res.json();
 * } catch (err) {
 *   if (err instanceof ApiError) {
 *     if (err.code === ApiErrorCode.Validation) showFieldErrors(err.details);
 *     else if (err.code === ApiErrorCode.Authentication) router.navigate(['/signin']);
 *     else throw err;
 *   } else {
 *     throw err; // network / parse / programmer error
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
  /** Durable string code from ShipAPI's `AppError` taxonomy. */
  readonly code: string;
  /** HTTP status code of the response that produced this error. */
  readonly status: number;
  /** Structured details payload, when the server attached one. */
  readonly details: unknown;

  constructor(envelope: ApiErrorEnvelope, status: number) {
    super(envelope.error.message);
    this.name = 'ApiError';
    this.code = envelope.error.code;
    this.status = status;
    this.details = envelope.error.details;
    // Restore prototype chain — required for `instanceof` to work across
    // Error subclasses when targeting ES5 lib output. Harmless on ES2022+.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Predicate guarding the well-known shape of {@link ApiErrorEnvelope}.
   * Use when you've parsed JSON manually and want to confirm it's a
   * ShipAPI error envelope before constructing.
   */
  static isEnvelope(value: unknown): value is ApiErrorEnvelope {
    if (typeof value !== 'object' || value === null) return false;
    const obj = value as Record<string, unknown>;
    if (obj['success'] !== false) return false;
    const err = obj['error'];
    if (typeof err !== 'object' || err === null) return false;
    const errObj = err as Record<string, unknown>;
    return typeof errObj['code'] === 'string' && typeof errObj['message'] === 'string';
  }

  /**
   * Build an `ApiError` from a known envelope + status. Useful when you've
   * already parsed the body (e.g., out of `await res.json()`) and want to
   * branch on the data before throwing.
   */
  static fromEnvelope(envelope: ApiErrorEnvelope, status: number): ApiError {
    if (status === 429) {
      return new RateLimitError(envelope, status, 0);
    }
    return new ApiError(envelope, status);
  }

  /**
   * Build an `ApiError` from a `fetch` `Response`. Reads the body, attempts
   * to parse it as a ShipAPI envelope, and falls back to a synthetic
   * envelope if the body is not envelope-shaped (e.g., proxy 502 with HTML).
   *
   * Reads `Retry-After` from the response headers when status is 429 and
   * surfaces it as `retryAfterSec` on the resulting {@link RateLimitError}.
   */
  static async fromResponse(res: Response): Promise<ApiError> {
    let envelope: ApiErrorEnvelope;
    try {
      const cloned = res.clone();
      const body: unknown = await cloned.json();
      if (ApiError.isEnvelope(body)) {
        envelope = body;
      } else {
        envelope = ApiError.syntheticEnvelope(res, undefined);
      }
    } catch {
      envelope = ApiError.syntheticEnvelope(res, undefined);
    }
    if (res.status === 429) {
      return new RateLimitError(envelope, res.status, parseRetryAfter(res));
    }
    return new ApiError(envelope, res.status);
  }

  /**
   * Build a synthetic envelope for non-ShipAPI error responses (proxy
   * errors, plain HTML, network failures wrapped to `Response`). Code maps
   * by status; message is the response statusText or a generic fallback.
   */
  private static syntheticEnvelope(res: Response, message: string | undefined): ApiErrorEnvelope {
    return {
      success: false,
      error: {
        code: codeForStatus(res.status),
        message: message ?? res.statusText ?? `HTTP ${res.status}`,
      },
    };
  }
}

/**
 * 429 Rate-Limit-Exceeded response. Carries the `Retry-After` header value
 * surfaced as `retryAfterSec` so apps can implement backoff cleanly.
 *
 * The rate-limit interceptor (`rateLimitInterceptor`) builds this when
 * configured to rethrow rather than auto-retry. The `withRateLimit(fetch)`
 * helper builds the same shape for `hc()` callers.
 */
export class RateLimitError extends ApiError {
  /**
   * Server-suggested wait before retrying, in seconds. Sourced from the
   * `Retry-After` HTTP header (HTTP-date forms are converted to seconds
   * relative to the response received-at time).
   *
   * Zero when the server omitted the header.
   */
  readonly retryAfterSec: number;

  constructor(envelope: ApiErrorEnvelope, status: number, retryAfterSec: number) {
    super(envelope, status);
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parse `Retry-After` from a `Response`. Supports both forms allowed by
 * RFC 7231: `<seconds>` (integer) and `<HTTP-date>` (resolved relative to
 * the response received-at time). Returns 0 on missing / malformed values.
 *
 * Exported for the rate-limit interceptor and `withRateLimit()` to reuse.
 */
export function parseRetryAfter(res: Response, now: number = Date.now()): number {
  const header = res.headers.get('Retry-After');
  if (!header) return 0;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.max(0, parseInt(trimmed, 10));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return 0;
  return Math.max(0, Math.ceil((dateMs - now) / 1000));
}

/**
 * Default code for a non-envelope response, indexed by HTTP status. Apps
 * that hit non-ShipAPI hosts (proxies, third-party APIs) get sensible
 * codes without ShipAPI's full taxonomy on the wire.
 */
function codeForStatus(status: number): string {
  if (status === 400) return ApiErrorCode.BadRequest;
  if (status === 401) return ApiErrorCode.Authentication;
  if (status === 403) return ApiErrorCode.Authorization;
  if (status === 404) return ApiErrorCode.NotFound;
  if (status === 409) return ApiErrorCode.Conflict;
  if (status === 422) return ApiErrorCode.Validation;
  if (status === 429) return ApiErrorCode.RateLimitExceeded;
  if (status === 503) return ApiErrorCode.Unavailable;
  if (status >= 500) return ApiErrorCode.Internal;
  return `HTTP_${status}`;
}
