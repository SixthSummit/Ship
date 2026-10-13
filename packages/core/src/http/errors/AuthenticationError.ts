import { AppError } from "./AppError.js";

/**
 * Error thrown when authentication is required or fails
 */
export class AuthenticationError extends AppError {
  constructor(message: string = "Authentication required") {
    super(message, 401, "AUTHENTICATION_ERROR");
  }
}
