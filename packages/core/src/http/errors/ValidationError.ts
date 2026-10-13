import { AppError } from "./AppError.js";

/**
 * Error thrown when input validation fails
 */
export class ValidationError extends AppError {
  public readonly details?: any;

  constructor(message: string, details?: any) {
    super(message, 400, "VALIDATION_ERROR");
    this.details = details;
  }
}
