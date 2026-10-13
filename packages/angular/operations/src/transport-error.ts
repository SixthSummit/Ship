import type { ResponseMetadata } from './response-metadata';

export type TransportFailureReason = 'network' | 'cors' | 'connection' | 'unavailable';

export interface TransportErrorOptions {
  readonly reason?: TransportFailureReason;
  readonly metadata?: ResponseMetadata;
  /** Safe category only; raw provider/network errors are deliberately not retained. */
  readonly causeName?: string;
}

/** Failure to reach or read the remote transport. */
export class TransportError extends Error {
  readonly kind = 'transport' as const;
  readonly reason: TransportFailureReason;
  readonly metadata?: ResponseMetadata;
  readonly causeName?: string;

  constructor(message: string, options: TransportErrorOptions = {}) {
    super(message);
    this.name = 'TransportError';
    this.reason = options.reason ?? 'network';
    if (options.metadata !== undefined) this.metadata = options.metadata;
    if (options.causeName !== undefined) this.causeName = options.causeName;
  }
}
