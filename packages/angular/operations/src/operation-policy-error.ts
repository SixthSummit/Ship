export type OperationPolicyFailureReason =
  | 'invalid-timeout'
  | 'invalid-retry-policy'
  | 'missing-operation-policy'
  | 'sensitive-header'
  | 'target-origin'
  | 'missing-credential'
  | 'missing-refresh-capability'
  | 'credential-failed'
  | 'csrf-unavailable'
  | 'idempotency-unsupported'
  | 'idempotency-required';

/** Local configuration or credential-policy failure detected before unsafe I/O. */
export class OperationPolicyError extends Error {
  readonly kind = 'policy' as const;
  readonly reason: OperationPolicyFailureReason;
  readonly causeName?: string;

  constructor(
    message: string,
    reason: OperationPolicyFailureReason,
    options: { readonly causeName?: string } = {}
  ) {
    super(message);
    this.name = 'OperationPolicyError';
    this.reason = reason;
    if (options.causeName !== undefined) this.causeName = options.causeName;
  }
}
