import { AppError } from "./AppError.js";

/**
 * Error thrown when a service is temporarily unavailable
 */
export class ServiceUnavailableError extends AppError {
  constructor(message: string = "Service temporarily unavailable") {
    super(message, 503, "SERVICE_UNAVAILABLE_ERROR");
  }
}
