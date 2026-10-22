import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import {
  attachmentPolicyFromManifest,
  createAttachmentUpload,
  type StorageContract,
} from './public-api';

interface AppContract extends StorageContract {
  readonly 'gallery.attach': {
    readonly input: { readonly body: { readonly objectId: string } };
    readonly success: { readonly 201: { readonly attached: true } };
    readonly errors: 'PHOTO_UNAVAILABLE';
    readonly transport: 'http';
  };
}

declare const client: OperationClient<AppContract>;
declare const file: File;
declare const manifest: {
  readonly attachments: {
    readonly 'gallery.photo': {
      readonly contentTypes: readonly string[];
      readonly maxBytes: number;
    };
  };
};

const upload = createAttachmentUpload(
  client,
  { attachment: 'gallery.photo', policy: attachmentPolicyFromManifest(manifest, 'gallery.photo') },
  { allowedProviderOrigins: ['https://storage.example.test'] }
);
void upload.start(file, { intent: { headers: { 'x-locale': 'en' } } });
const object = upload.object();
if (object !== undefined) {
  object.objectId satisfies string;
  void client.call('gallery.attach', { body: { objectId: object.objectId } });
}

interface WithoutStorage {
  readonly 'gallery.attach': AppContract['gallery.attach'];
}
declare const bare: OperationClient<WithoutStorage>;
// @ts-expect-error a contract without the storage module's operations cannot drive an attachment upload
void createAttachmentUpload(
  bare,
  { attachment: 'gallery.photo', policy: { contentTypes: [], maxBytes: 1 } },
  {
    allowedProviderOrigins: [],
  }
);
