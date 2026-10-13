/**
 * Result of a batch email operation
 */
export interface SendBatchEmailsResult {
  /** Array of email IDs (if successful) */
  data?: Array<{ id: string }>;
  /** Error (if failed) */
  error?: Error;
}
