---
"@sixthsummit/ship-angular": minor
---

Add the `/storage` entrypoint: `createAttachmentUpload(client, { attachment, policy }, { allowedProviderOrigins })` validates a file against the policy read from the manifest with `attachmentPolicyFromManifest`, obtains a signed intent from `ship-storage.create-intent`, PUTs the bytes to the provider with progress through the signed-upload lifecycle, settles through `ship-storage.complete`, and exposes the settled `object` signal for the application's own attach operation. `attachmentUploadFailure` narrows a failed result to its stage.
