/**
 * Error object carried by the canonical streaming wire contract.
 *
 * The same shape appears in two places: the `error` SSE event's `data`, and the
 * `error` member of the ADR-0005 JSON error envelope returned when the request
 * fails before the first frame.
 */
export interface ShipStreamError {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: unknown;
}

/** The connection closed without a `terminal` or `error` event. */
export const STREAM_INTERRUPTED = 'STREAM_INTERRUPTED';

/** The request never produced a response (DNS, TLS, CORS, offline, blocked redirect). */
export const STREAM_TRANSPORT_FAILED = 'STREAM_TRANSPORT_FAILED';

/** A response arrived but did not satisfy the streaming wire contract. */
export const STREAM_PROTOCOL_VIOLATION = 'STREAM_PROTOCOL_VIOLATION';

/**
 * Codes ShipAngular reports locally, for failures the server never got to name.
 *
 * `STREAM_INTERRUPTED` is defined by the wire contract. The other two are
 * ShipAngular-local: the contract does not name a code for a request that never
 * reached the server, or for a response that violated the framing.
 */
export type ShipStreamLocalErrorCode =
  | typeof STREAM_INTERRUPTED
  | typeof STREAM_TRANSPORT_FAILED
  | typeof STREAM_PROTOCOL_VIOLATION;

/** Narrow an `error` event payload to the wire error object. */
export function isShipStreamError(value: unknown): value is ShipStreamError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    typeof candidate['code'] === 'string' &&
    candidate['code'].length > 0 &&
    typeof candidate['status'] === 'number' &&
    Number.isInteger(candidate['status']) &&
    typeof candidate['message'] === 'string'
  );
}
