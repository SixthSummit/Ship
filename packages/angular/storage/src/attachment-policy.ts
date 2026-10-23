/** The client-side slice of a declared attachment: what the manifest projects, nothing provider-shaped. */
export interface AttachmentUploadPolicy {
  readonly contentTypes: readonly string[];
  readonly maxBytes: number;
  readonly cardinality?: 'single' | 'many';
  readonly maxCount?: number;
}

/** The manifest shape `projectClientContract` emits for attachments; structural so no server import is needed. */
export interface AttachmentManifest {
  readonly attachments?: Readonly<
    Record<
      string,
      {
        readonly contentTypes: readonly string[];
        readonly maxBytes: number;
        readonly cardinality?: 'single' | 'many';
        readonly maxCount?: number;
      }
    >
  >;
}

export class AttachmentPolicyError extends Error {
  readonly kind = 'attachment-policy' as const;
  readonly attachmentId: string;

  constructor(attachmentId: string) {
    super(`The client manifest declares no attachment ${JSON.stringify(attachmentId)}`);
    this.name = 'AttachmentPolicyError';
    this.attachmentId = attachmentId;
  }
}

/** Reads one attachment's upload policy from the client manifest so validation never drifts from the declaration. */
export function attachmentPolicyFromManifest(
  manifest: AttachmentManifest,
  attachmentId: string
): AttachmentUploadPolicy {
  const declared = manifest.attachments?.[attachmentId];
  if (declared === undefined) throw new AttachmentPolicyError(attachmentId);
  return {
    contentTypes: [...declared.contentTypes],
    maxBytes: declared.maxBytes,
    ...(declared.cardinality === undefined ? {} : { cardinality: declared.cardinality }),
    ...(declared.maxCount === undefined ? {} : { maxCount: declared.maxCount }),
  };
}
