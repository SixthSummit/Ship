/** Transport facts about the caller, recorded on sessions and audit rows. */
export interface RequestClient {
  readonly ip?: string;
  readonly userAgent?: string;
  /**
   * How the request authenticated, recorded by the resolver so an operation
   * on the current session (sign-out, revoke, MFA confirmation) knows whether
   * to clear or rotate the session cookie. Absent on anonymous requests.
   */
  readonly sessionTransport?: "bearer" | "cookie";
}

/**
 * Carries the client facts the credential adapter saw on a request to the
 * operation handler that audits it, keyed by request id. Entries are
 * process-local and bounded; the registry is a convenience for audit
 * attribution, never an authorization input.
 */
export interface RequestClientRegistry {
  record(requestId: string, client: RequestClient): void;
  get(requestId: string): RequestClient | undefined;
}

export function createRequestClientRegistry(
  options: { readonly capacity?: number } = {},
): RequestClientRegistry {
  const capacity = options.capacity ?? 10_000;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new TypeError("request client registry capacity must be a positive integer");
  }
  const entries = new Map<string, RequestClient>();
  return Object.freeze({
    record(requestId: string, client: RequestClient): void {
      if (entries.has(requestId)) entries.delete(requestId);
      entries.set(requestId, Object.freeze({ ...client }));
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get(requestId: string): RequestClient | undefined {
      return entries.get(requestId);
    },
  });
}

/** The first `X-Forwarded-For` hop, then `X-Real-IP`; trust these only behind a proxy that overwrites them. */
export function readRequestClient(request: Request): RequestClient {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = request.headers.get("x-real-ip")?.trim();
  const ip = forwarded || real || undefined;
  const userAgent = request.headers.get("user-agent")?.slice(0, 512) ?? undefined;
  return Object.freeze({
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  });
}
