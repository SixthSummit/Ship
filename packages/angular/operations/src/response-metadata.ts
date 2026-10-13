/** Browser-readable response metadata retained at the operation boundary. */
export interface ResponseMetadata {
  /** All browser-readable headers, normalized to lowercase keys. */
  readonly headers: Readonly<Record<string, string>>;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly etag?: string;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyReplayed?: boolean;
  readonly idempotencyResult?: string;
}

/** Metadata value for clients that have no response headers to expose. */
export const EMPTY_RESPONSE_METADATA: ResponseMetadata = Object.freeze({
  headers: Object.freeze({}),
});

export interface ResponseMetadataHeaderNames {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly idempotencyReplayed: string;
  readonly idempotencyResult: string;
}

const DEFAULT_HEADER_NAMES: ResponseMetadataHeaderNames = {
  requestId: 'x-request-id',
  idempotencyKey: 'idempotency-key',
  idempotencyReplayed: 'idempotency-replayed',
  idempotencyResult: 'idempotency-result',
};

/** Copy browser-readable headers and project well-known operation metadata. */
export function responseMetadataFromHeaders(
  source: Headers,
  now = Date.now(),
  names: Partial<ResponseMetadataHeaderNames> = {}
): ResponseMetadata {
  const headerNames = { ...DEFAULT_HEADER_NAMES, ...names };
  const headers: Record<string, string> = {};
  source.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const read = (name: string): string | undefined => source.get(name) ?? undefined;
  const replayed = read(headerNames.idempotencyReplayed);
  const requestId = read(headerNames.requestId);
  const retryAfterMs = parseRetryAfterMs(source.get('retry-after'), now);
  const etag = read('etag');
  const contentType = read('content-type');
  const contentDisposition = read('content-disposition');
  const idempotencyKey = read(headerNames.idempotencyKey);
  const idempotencyReplayed = replayed === undefined ? undefined : replayed === 'true';
  const idempotencyResult = read(headerNames.idempotencyResult);

  return {
    headers: Object.freeze(headers),
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(etag === undefined ? {} : { etag }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(contentDisposition === undefined ? {} : { contentDisposition }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(idempotencyReplayed === undefined ? {} : { idempotencyReplayed }),
    ...(idempotencyResult === undefined ? {} : { idempotencyResult }),
  };
}

/** Parse either legal Retry-After form into a non-negative millisecond delay. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
