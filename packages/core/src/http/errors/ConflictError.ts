import { AppError } from "./AppError.js";

/**
 * Error thrown when there's a conflict with existing resources
 */
export class ConflictError extends AppError {
  constructor(message: string = "Resource conflict") {
    super(message, 409, "CONFLICT_ERROR");
  }
}
