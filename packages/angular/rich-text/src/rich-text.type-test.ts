import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import type { StorageContract } from '@sixthsummit/ship-angular/storage';
import {
  createRichTextAttachmentUploader,
  type RichTextDocument,
  richTextFieldFromManifest,
  ShipRichTextEditorComponent,
} from './public-api';

declare const manifest: {
  readonly richText: {
    readonly 'documents.body': {
      readonly schemaVersion: number;
      readonly attachment: string;
      readonly maxBytes: number;
      readonly maxDepth: number;
      readonly extensions: readonly [];
    };
  };
};
declare const client: OperationClient<StorageContract>;
declare const editor: ShipRichTextEditorComponent;

const policy = richTextFieldFromManifest(manifest, 'documents.body');
policy.attachment satisfies string | undefined;

const upload = createRichTextAttachmentUploader(
  client,
  { attachment: 'documents.image', policy: { contentTypes: ['image/png'], maxBytes: 1 } },
  { allowedProviderOrigins: ['https://storage.example.test'] }
);
void upload(new File([], 'x.png')).then(({ objectId }) => objectId satisfies string);

editor.documentChange.subscribe((document: RichTextDocument) => {
  document.schemaVersion satisfies number;
  document.type satisfies 'doc';
});

editor.documentChange.subscribe(document => {
  // @ts-expect-error the editor emits the document model, never an HTML string
  const html: string = document;
  return html;
});

interface WithoutStorage {
  readonly 'documents.save': {
    readonly input: { readonly body: { readonly document: RichTextDocument } };
    readonly success: { readonly 200: { readonly saved: true } };
    readonly errors: 'DOCUMENT_INVALID';
    readonly transport: 'http';
  };
}
declare const bare: OperationClient<WithoutStorage>;
void createRichTextAttachmentUploader(
  // @ts-expect-error a contract without the storage module's operations cannot upload embedded images
  bare,
  { attachment: 'documents.image', policy: { contentTypes: [], maxBytes: 1 } },
  { allowedProviderOrigins: [] }
);
