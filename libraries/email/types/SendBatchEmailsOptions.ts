import type { SendEmailOptions } from "./SendEmailOptions.js";

/**
 * Options for sending multiple emails in a batch
 */
export interface SendBatchEmailsOptions {
  /** Array of emails to send (max 100) */
  emails: SendEmailOptions[];
}
