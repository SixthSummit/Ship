import { AppError } from "./AppError.js";

/**
 * Error thrown for general bad request scenarios
 */
export class BadRequestError extends AppError {
  constructor(message: string = "Bad request") {
    super(message, 400, "BAD_REQUEST_ERROR");
  }
}
