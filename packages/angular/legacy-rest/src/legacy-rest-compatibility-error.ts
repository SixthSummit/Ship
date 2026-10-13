export type LegacyRestCompatibilityFailureReason =
  | 'missing-operation-mapping'
  | 'unsupported-success-status';

/** An actionable limitation or incomplete mapping at the temporary URL-client boundary. */
export class LegacyRestCompatibilityError extends Error {
  readonly kind = 'legacy-rest-compatibility' as const;
  readonly reason: LegacyRestCompatibilityFailureReason;
  readonly operation: string;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      readonly reason: LegacyRestCompatibilityFailureReason;
      readonly operation: string;
      readonly status?: number;
    }
  ) {
    super(message);
    this.name = 'LegacyRestCompatibilityError';
    this.reason = options.reason;
    this.operation = options.operation;
    if (options.status !== undefined) this.status = options.status;
  }
}
