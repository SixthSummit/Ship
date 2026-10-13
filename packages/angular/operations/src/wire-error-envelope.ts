import type { OperationFailure } from './operation-result';
import { ProtocolError } from './protocol-error';
import { type ResponseMetadata, responseMetadataFromHeaders } from './response-metadata';
import type { ShipError } from './ship-error';

/** Minimum stable ShipAPI JSON error envelope plus preserved additive fields. */
export interface WireErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly requestId?: string;
    readonly [key: string]: unknown;
  };
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

/** Narrow an unknown JSON value to the minimum stable error envelope. */
export function isWireErrorEnvelope(value: unknown): value is WireErrorEnvelope {
  if (!isRecord(value) || value['success'] !== false || !isRecord(value['error'])) return false;
  return (
    typeof value['error']['code'] === 'string' && typeof value['error']['message'] === 'string'
  );
}

/** Convert a validated wire envelope into a declared-or-unknown failed result. */
export function failureFromErrorEnvelope<TCode extends string>(
  envelope: WireErrorEnvelope,
  status: number,
  metadata: ResponseMetadata,
  declaredCodes: ReadonlySet<TCode> | readonly TCode[]
): OperationFailure<TCode> {
  const declared = Array.isArray(declaredCodes)
    ? declaredCodes.includes(envelope.error.code as TCode)
    : (declaredCodes as ReadonlySet<TCode>).has(envelope.error.code as TCode);
  const requestId = metadata.requestId ?? envelope.error.requestId ?? envelope.requestId;
  const extensions = withoutKeys(envelope.error, ['code', 'message', 'details', 'requestId']);
  const envelopeExtensions = withoutKeys(envelope, ['success', 'error', 'requestId']);
  const common = {
    code: envelope.error.code,
    message: envelope.error.message,
    ...(envelope.error.details === undefined ? {} : { details: envelope.error.details }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(envelopeExtensions === undefined ? {} : { envelopeExtensions }),
  };
  const error: ShipError<TCode> = declared
    ? { ...common, declared: true, code: envelope.error.code as TCode }
    : { ...common, declared: false };

  return { ok: false, status, error, headers: metadata };
}

/** Parse an HTTP failure without relabeling malformed proxy responses as application errors. */
export async function failureFromResponse<TCode extends string>(
  response: Response,
  declaredCodes: ReadonlySet<TCode> | readonly TCode[],
  now = Date.now()
): Promise<OperationFailure<TCode>> {
  const metadata = responseMetadataFromHeaders(response.headers, now);
  const contentType = response.headers.get('content-type');
  if (!contentType?.toLowerCase().includes('json')) {
    throw new ProtocolError('Expected a JSON application error response', {
      reason: 'unexpected-content-type',
      status: response.status,
      metadata,
      ...(contentType === null ? {} : { receivedContentType: contentType }),
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProtocolError('The application error response was not valid JSON', {
      reason: 'invalid-json',
      status: response.status,
      metadata,
      receivedContentType: contentType,
    });
  }
  if (!isWireErrorEnvelope(body)) {
    throw new ProtocolError('The JSON response did not match the application error envelope', {
      reason: 'invalid-envelope',
      status: response.status,
      metadata,
      receivedContentType: contentType,
    });
  }
  return failureFromErrorEnvelope(body, response.status, metadata, declaredCodes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutKeys(
  value: Readonly<Record<string, unknown>>,
  excluded: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  const entries = Object.entries(value).filter(([key]) => !excluded.includes(key));
  return entries.length > 0 ? Object.freeze(Object.fromEntries(entries)) : undefined;
}
