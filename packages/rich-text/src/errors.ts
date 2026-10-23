import type { RichTextIssue } from "@sixthsummit/ship-core";

export type RichTextCapabilityErrorCode =
  | "SHIP_RICH_TEXT_INVALID"
  | "SHIP_RICH_TEXT_SCHEMA_VERSION_UNSUPPORTED"
  | "SHIP_RICH_TEXT_ATTACHMENTS_UNCONFIGURED"
  | "SHIP_RICH_TEXT_SCOPE_REQUIRED";

/**
 * Raised by the scoped capability. Handlers translate `SHIP_RICH_TEXT_INVALID`
 * (with its issues) into their own declared `operationFailure`; the other
 * codes are composition mistakes and are the right outcome for a bug.
 */
export class RichTextCapabilityError extends Error {
  readonly code: RichTextCapabilityErrorCode;
  readonly fieldId: string;
  readonly issues: readonly RichTextIssue[];

  constructor(
    code: RichTextCapabilityErrorCode,
    message: string,
    options: { readonly fieldId: string; readonly issues?: readonly RichTextIssue[] },
  ) {
    super(message);
    this.name = "RichTextCapabilityError";
    this.code = code;
    this.fieldId = options.fieldId;
    this.issues = Object.freeze([...(options.issues ?? [])]);
  }
}
