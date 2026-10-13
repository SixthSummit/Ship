import type { EmailAddress } from "./EmailAddress.js";
import type { EmailAttachment } from "./EmailAttachment.js";
import type { EmailTag } from "./EmailTag.js";

/**
 * Options for sending a single email
 */
export interface SendEmailOptions {
  /** Sender email address */
  from?: string;
  /** Recipient email address(es) */
  to: EmailAddress | EmailAddress[];
  /** Email subject */
  subject: string;
  /** Plain text content */
  text?: string;
  /** HTML content */
  html?: string;
  /** CC recipients */
  cc?: EmailAddress | EmailAddress[];
  /** BCC recipients */
  bcc?: EmailAddress | EmailAddress[];
  /** Reply-to address(es) */
  replyTo?: EmailAddress | EmailAddress[];
  /** Email attachments */
  attachments?: EmailAttachment[];
  /** Email tags for tracking */
  tags?: EmailTag[];
  /** Custom headers */
  headers?: Record<string, string>;
  /** Schedule email to be sent at a specific time (ISO 8601 format) */
  scheduledAt?: string;
}
