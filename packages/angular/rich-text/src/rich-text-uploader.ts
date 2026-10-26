import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import {
  type AttachmentUploadBinding,
  type CreateAttachmentUploadOptions,
  createAttachmentUpload,
  type StorageContract,
} from '@sixthsummit/ship-angular/storage';
import type { RichTextAttachmentUploader } from './rich-text-editor.component';

/**
 * Builds the editor's uploader on the storage entrypoint: each dropped or
 * pasted image becomes one managed attachment upload (validated against the
 * declared policy, signed intent, PUT with progress, completion) and the
 * editor inserts the settled object id. The owning record attaches the
 * object when the document is saved.
 */
export function createRichTextAttachmentUploader<TContract extends StorageContract>(
  client: OperationClient<TContract>,
  binding: AttachmentUploadBinding,
  options: CreateAttachmentUploadOptions
): RichTextAttachmentUploader {
  return async file => {
    const upload = createAttachmentUpload(client, binding, options);
    try {
      const result = await upload.start(file);
      const object = upload.object();
      if (!result.ok || object === undefined) {
        throw (
          upload.error() ??
          new Error(`attachment upload failed at ${result.ok ? 'completion' : result.stage}`)
        );
      }
      return { objectId: object.objectId };
    } finally {
      upload.destroy();
    }
  };
}
