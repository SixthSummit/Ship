export type DrizzleRepositoryErrorCode =
  | "SHIP_DRIZZLE_PAGINATION_INVALID"
  | "SHIP_DRIZZLE_PAGE_RESULT_INVALID"
  | "SHIP_DRIZZLE_AUDIT_COLUMNS_INVALID"
  | "SHIP_DRIZZLE_SOFT_DELETE_COLUMNS_INVALID"
  | "SHIP_DRIZZLE_PROJECTIONS_INVALID"
  | "SHIP_DRIZZLE_PROJECTION_UNKNOWN"
  | "SHIP_DRIZZLE_TENANT_REPOSITORY_INVALID"
  | "SHIP_DRIZZLE_TENANT_SCOPE_REQUIRED"
  | "SHIP_DRIZZLE_OUTBOX_INVALID"
  | "SHIP_DRIZZLE_OUTBOX_SCOPE_INVALID"
  | "SHIP_DRIZZLE_IDEMPOTENCY_INVALID"
  | "SHIP_DRIZZLE_WEBHOOK_EVENTS_INVALID"
  | "SHIP_DRIZZLE_WEBHOOK_EVENTS_SCOPE_INVALID"
  | "SHIP_DRIZZLE_LOCK_INVALID"
  | "SHIP_DRIZZLE_JOB_BACKEND_INVALID"
  | "SHIP_DRIZZLE_JOB_LEASE_STALE";

export class DrizzleRepositoryError extends Error {
  readonly code: DrizzleRepositoryErrorCode;
  readonly field?: string;
  readonly projection?: string;
  readonly repositoryId?: string;
  readonly accessMode?: "scoped" | "privileged";
  readonly jobId?: string;
  readonly runId?: string;

  constructor(
    code: DrizzleRepositoryErrorCode,
    message: string,
    options: {
      readonly field?: string;
      readonly projection?: string;
      readonly repositoryId?: string;
      readonly accessMode?: "scoped" | "privileged";
      readonly jobId?: string;
      readonly runId?: string;
    } = {},
  ) {
    super(message);
    this.name = "DrizzleRepositoryError";
    this.code = code;
    this.field = options.field;
    this.projection = options.projection;
    this.repositoryId = options.repositoryId;
    this.accessMode = options.accessMode;
    this.jobId = options.jobId;
    this.runId = options.runId;
  }
}
