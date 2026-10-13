import { ProtocolError } from '@sixthsummit/ship-angular/operations';

/** HTTP methods the streaming wire contract allows for a stream operation. */
export type ShipStreamMethod = 'GET' | 'POST';

/** Server-declared stream bounds projected into the manifest. */
export interface ShipStreamLimits {
  readonly heartbeatMs: number;
  readonly maxDurationMs: number;
  readonly maxFrames: number;
}

/** `operations[id].response` for an operation declared with `mode: "stream"`. */
export interface ShipStreamResponseDeclaration {
  readonly mode: 'stream';
  readonly framing: 'sse';
  /** Opaque schema reference. The client never interprets it; it participates in the fingerprint. */
  readonly frame: unknown;
  readonly terminal?: unknown;
  readonly limits: ShipStreamLimits;
}

/**
 * One manifest entry.
 *
 * Structurally a superset of the entries in `ShipApiClientContractManifest`, so an
 * application can hand its existing ShipAPI manifest to {@link resolveShipStreamOperation}
 * without a cast. Non-stream operations simply omit `response`.
 */
export interface ShipStreamManifestEntry {
  readonly id: string;
  readonly method?: string;
  readonly path?: string;
  readonly success: readonly { readonly status: number }[];
  readonly errors: readonly { readonly code: string; readonly status: number }[];
  readonly response?: {
    readonly mode: string;
    readonly framing?: string;
    readonly frame?: unknown;
    readonly terminal?: unknown;
    readonly limits?: {
      readonly heartbeatMs?: number;
      readonly maxDurationMs?: number;
      readonly maxFrames?: number;
    };
  };
}

/** Browser-safe ShipAPI manifest projection consumed by the stream client. */
export interface ShipStreamManifest {
  readonly schemaVersion: 1;
  readonly appId: string;
  readonly fingerprint: `sha256:${string}`;
  readonly operations: readonly ShipStreamManifestEntry[];
}

/** A validated stream operation: everything the client needs to open the connection. */
export interface ShipStreamManifestOperation {
  readonly id: string;
  readonly method: ShipStreamMethod;
  readonly path: string;
  readonly successStatuses: readonly number[];
  readonly declaredErrorCodes: readonly string[];
  readonly response: ShipStreamResponseDeclaration;
}

/**
 * Resolve and validate one `mode: "stream"` operation from a ShipAPI manifest.
 *
 * Every rejection is a {@link ProtocolError}: a manifest that does not describe a
 * conforming stream is a contract defect, not an application error.
 */
export function resolveShipStreamOperation(
  manifest: ShipStreamManifest,
  operationId: string
): ShipStreamManifestOperation {
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.appId !== 'string' ||
    manifest.appId.length === 0 ||
    typeof manifest.fingerprint !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.fingerprint) ||
    !Array.isArray(manifest.operations)
  ) {
    invalid('The ShipAPI stream manifest is invalid');
  }

  const entry = manifest.operations.find(candidate => candidate?.id === operationId);
  if (entry === undefined) {
    invalid(`Operation ${operationId} is absent from the ShipAPI manifest`);
  }
  const response = entry.response;
  if (response === undefined || response.mode !== 'stream') {
    invalid(`Operation ${operationId} is not declared with response mode "stream"`);
  }
  if (response.framing !== 'sse') {
    invalid(`Operation ${operationId} declares an unsupported stream framing`);
  }
  if (entry.method !== 'GET' && entry.method !== 'POST') {
    invalid(`Operation ${operationId} declares an unsupported stream method`);
  }
  if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
    invalid(`Operation ${operationId} declares an invalid stream path`);
  }
  const limits = response.limits;
  if (
    limits === undefined ||
    !isPositiveInteger(limits.heartbeatMs) ||
    !isPositiveInteger(limits.maxDurationMs) ||
    !isPositiveInteger(limits.maxFrames)
  ) {
    invalid(`Operation ${operationId} declares invalid stream limits`);
  }
  if (!Array.isArray(entry.success) || !Array.isArray(entry.errors)) {
    invalid(`Operation ${operationId} declares an invalid success or error projection`);
  }

  return {
    id: entry.id,
    method: entry.method,
    path: entry.path,
    successStatuses: entry.success.map((success: { readonly status: number }) => success.status),
    declaredErrorCodes: entry.errors.map((error: { readonly code: string }) => error.code),
    response: {
      mode: 'stream',
      framing: 'sse',
      frame: response.frame,
      ...(response.terminal === undefined ? {} : { terminal: response.terminal }),
      limits: {
        heartbeatMs: limits.heartbeatMs,
        maxDurationMs: limits.maxDurationMs,
        maxFrames: limits.maxFrames,
      },
    },
  };
}

function isPositiveInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function invalid(message: string): never {
  throw new ProtocolError(message, { reason: 'invalid-envelope' });
}
