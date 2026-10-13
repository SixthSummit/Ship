/**
 * Error codes for Weaviate operations
 */
export enum WeaviateErrorCode {
  // Schema errors
  SCHEMA_VALIDATION_ERROR = "SCHEMA_VALIDATION_ERROR",
  SCHEMA_CREATION_ERROR = "SCHEMA_CREATION_ERROR",
  SCHEMA_NOT_FOUND = "SCHEMA_NOT_FOUND",

  // Search errors
  SEARCH_ERROR = "SEARCH_ERROR",
  INVALID_SEARCH_METHOD = "INVALID_SEARCH_METHOD",

  // CRUD errors
  OBJECT_CREATION_ERROR = "OBJECT_CREATION_ERROR",
  OBJECT_UPDATE_ERROR = "OBJECT_UPDATE_ERROR",
  OBJECT_DELETE_ERROR = "OBJECT_DELETE_ERROR",
  OBJECT_RETRIEVAL_ERROR = "OBJECT_RETRIEVAL_ERROR",
  BATCH_OPERATION_ERROR = "BATCH_OPERATION_ERROR",

  // Tenant errors
  TENANT_CREATION_ERROR = "TENANT_CREATION_ERROR",
  TENANT_UPDATE_ERROR = "TENANT_UPDATE_ERROR",
  TENANT_DELETE_ERROR = "TENANT_DELETE_ERROR",
  TENANT_RETRIEVAL_ERROR = "TENANT_RETRIEVAL_ERROR",
  TENANT_VALIDATION_ERROR = "TENANT_VALIDATION_ERROR",
  TENANT_NOT_FOUND = "TENANT_NOT_FOUND",

  // General errors
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  CONNECTION_ERROR = "CONNECTION_ERROR",
}

/**
 * Custom error class for Weaviate operations
 * Provides structured error information with error codes and additional details
 */
export class WeaviateError extends Error {
  /**
   * Creates a new WeaviateError
   * @param message - Human-readable error message
   * @param code - Error code for programmatic handling
   * @param details - Additional error details or the original error
   */
  constructor(
    message: string,
    public readonly code: WeaviateErrorCode,
    public readonly details?: any,
  ) {
    super(message);
    this.name = "WeaviateError";

    // Maintain proper stack trace for debugging
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, WeaviateError);
    }
  }

  /**
   * Check if the error is a specific type
   */
  is(code: WeaviateErrorCode): boolean {
    return this.code === code;
  }

  /**
   * Get a JSON representation of the error
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      stack: this.stack,
    };
  }

  /**
   * Create a WeaviateError from an unknown error
   */
  static from(error: unknown, code: WeaviateErrorCode, message?: string): WeaviateError {
    if (error instanceof WeaviateError) {
      return error;
    }

    const errorMessage = message || (error instanceof Error ? error.message : String(error));

    return new WeaviateError(errorMessage, code, error);
  }
}
