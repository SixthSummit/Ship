/**
 * Result of sending a single email
 */
export interface SendEmailResult {
  /** Email ID from Resend (if successful) */
  id?: string;
  /** Error (if failed) */
  error?: Error;
}
