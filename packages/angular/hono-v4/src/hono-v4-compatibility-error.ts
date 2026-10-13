export type HonoV4CompatibilityFailureReason =
  | 'missing-operation-mapping'
  | 'unsupported-success-status';

/** An actionable limitation or incomplete mapping at the temporary Hono v4 boundary. */
export class HonoV4CompatibilityError extends Error {
  readonly kind = 'hono-v4-compatibility' as const;
  readonly reason: HonoV4CompatibilityFailureReason;
  readonly operation: string;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      readonly reason: HonoV4CompatibilityFailureReason;
      readonly operation: string;
      readonly status?: number;
    }
  ) {
    super(message);
    this.name = 'HonoV4CompatibilityError';
    this.reason = options.reason;
    this.operation = options.operation;
    if (options.status !== undefined) this.status = options.status;
  }
}
