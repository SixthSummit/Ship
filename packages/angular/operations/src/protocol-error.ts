import type { ResponseMetadata } from './response-metadata';

export type ProtocolFailureReason =
  | 'invalid-json'
  | 'invalid-envelope'
  | 'unexpected-status'
  | 'unexpected-content-type'
  | 'invalid-event'
  | 'invalid-message'
  /** The browser answered a declared redirect operation with an opaque redirect it will not expose. */
  | 'opaque-redirect';

export interface ProtocolErrorOptions {
  readonly reason: ProtocolFailureReason;
  readonly status?: number;
  readonly metadata?: ResponseMetadata;
  readonly receivedContentType?: string;
}

/** A response arrived but did not satisfy the declared client protocol. */
export class ProtocolError extends Error {
  readonly kind = 'protocol' as const;
  readonly reason: ProtocolFailureReason;
  readonly status?: number;
  readonly metadata?: ResponseMetadata;
  readonly receivedContentType?: string;

  constructor(message: string, options: ProtocolErrorOptions) {
    super(message);
    this.name = 'ProtocolError';
    this.reason = options.reason;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
    if (options.receivedContentType !== undefined) {
      this.receivedContentType = options.receivedContentType;
    }
  }
}
