import { AppError } from "./AppError.js";

/**
 * Error thrown when a rate-limit ceiling is exceeded.
 *
 * Mapped to 429 by `registerErrorHandlers`. The `retryAfterSec` field is
 * surfaced as the `Retry-After` response header by the rate-limit
 * middleware itself (set before throwing).
 */
export class RateLimitError extends AppError {
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number, message = "Too many requests") {
    super(message, 429, "RATE_LIMIT_EXCEEDED");
    this.retryAfterSec = retryAfterSec;
  }
}
