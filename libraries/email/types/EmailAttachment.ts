/**
 * Email attachment
 */
export interface EmailAttachment {
  /** Attachment filename */
  filename: string;
  /** Attachment content (Buffer or base64 string) */
  content: Buffer | string;
  /** Content type (MIME type) */
  contentType?: string;
}
