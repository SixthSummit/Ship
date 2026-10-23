/** @packageDocumentation Typed, progress-aware managed attachment uploads for ShipAPI's storage module. */

export {
  type AttachmentManifest,
  AttachmentPolicyError,
  type AttachmentUploadPolicy,
  attachmentPolicyFromManifest,
} from './attachment-policy';
export {
  type AttachmentUpload,
  type AttachmentUploadBinding,
  type AttachmentUploadCallOptions,
  type AttachmentUploadResult,
  type AttachmentUploadStatus,
  attachmentUploadFailure,
  type CreateAttachmentUploadOptions,
  createAttachmentUpload,
  STORAGE_COMPLETE_OPERATION_ID,
  STORAGE_CREATE_INTENT_OPERATION_ID,
  type StorageCompletionData,
  type StorageContract,
  type StorageIntentData,
} from './create-attachment-upload';
