export type OperationUploadValidationIssue =
  | {
      readonly reason: 'invalid-file-count';
      readonly field: string;
      readonly minimum: number;
      readonly maximum: number;
      readonly actual: number;
    }
  | {
      readonly reason: 'file-too-large';
      readonly field: string;
      readonly maximumBytes: number;
      readonly actualBytes: number;
    }
  | {
      readonly reason: 'unsupported-media-type';
      readonly field: string;
      readonly acceptedMediaTypes: readonly string[];
      readonly actualMediaType: string;
    };

/** Advisory browser validation failure. The server remains authoritative. */
export class OperationUploadValidationError extends Error {
  readonly kind = 'upload-validation' as const;
  readonly issues: readonly OperationUploadValidationIssue[];

  constructor(issues: readonly OperationUploadValidationIssue[]) {
    super('The selected upload files do not satisfy the declared browser constraints');
    this.name = 'OperationUploadValidationError';
    this.issues = Object.freeze([...issues]);
  }
}
