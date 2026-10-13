import { AppError } from "./AppError.js";

/**
 * Error thrown when user lacks sufficient permissions
 */
export class AuthorizationError extends AppError {
  constructor(message: string = "Insufficient permissions") {
    super(message, 403, "AUTHORIZATION_ERROR");
  }
}
