import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Slice } from '@tiptap/pm/model';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RichTextDocument } from './rich-text-document';
import {
  type RichTextAttachmentUploader,
  ShipRichTextEditorComponent,
} from './rich-text-editor.component';
import type { RichTextFieldPolicy } from './rich-text-field';
import { installProseMirrorDomShims } from './test-dom-shims';

const policy: RichTextFieldPolicy = {
  id: 'documents.body',
  schemaVersion: 1,
  attachment: 'documents.image',
  maxBytes: 262144,
  maxDepth: 32,
  extensions: [],
};

@Component({
  standalone: true,
  imports: [ReactiveFormsModule, ShipRichTextEditorComponent],
  template: `
    <ship-rich-text-editor
      [field]="policy"
      [uploadAttachment]="upload"
      [resolveAttachment]="resolve"
      [formControl]="control"
      (documentChange)="emitted.push($event)"
      (uploadError)="failures.push($event.error)"
    />
  `,
})
class HostComponent {
  readonly policy = policy;
  readonly control = new FormControl<RichTextDocument | null>(null);
  upload: RichTextAttachmentUploader | undefined;
  readonly resolve = async (objectId: string) =>
    objectId === 'known' ? { url: 'https://cdn.test/known', contentType: 'image/png' } : undefined;
  readonly emitted: RichTextDocument[] = [];
  readonly failures: unknown[] = [];
}

/** jsdom has no DataTransfer; this is the slice of it ProseMirror and the editor read. */
function transfer(options: { readonly html?: string; readonly files?: readonly File[] }) {
  const files = options.files ?? [];
  const list = Object.assign([...files], { item: (index: number) => files[index] ?? null });
  return {
    getData: (type: string) => (type === 'text/html' ? (options.html ?? '') : ''),
    types: [...(options.html ? ['text/html'] : []), ...(files.length > 0 ? ['Files'] : [])],
    files: list as unknown as FileList,
    items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  };
}

function pasteEvent(options: Parameters<typeof transfer>[0]): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: transfer(options) });
  return event;
}

function dropEvent(options: Parameters<typeof transfer>[0]): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: transfer(options) });
  Object.defineProperty(event, 'clientX', { value: 0 });
  Object.defineProperty(event, 'clientY', { value: 0 });
  return event;
}

function paragraph(text: string): RichTextDocument {
  return {
    schemaVersion: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

async function mount() {
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(HostComponent);
  await fixture.whenStable();
  const editor = fixture.debugElement.children[0]?.componentInstance as ShipRichTextEditorComponent;
  return {
    fixture,
    host: fixture.componentInstance,
    editor,
    element: fixture.nativeElement as HTMLElement,
  };
}

describe('ShipRichTextEditorComponent', () => {
  beforeAll(() => installProseMirrorDomShims());

  it('binds to a form control, emitting the document model and never HTML', async () => {
    const { fixture, host, editor } = await mount();
    expect(editor.tiptap).toBeDefined();
    host.control.setValue(paragraph('from the form'));
    await fixture.whenStable();
    expect(editor.tiptap?.getText()).toBe('from the form');
    expect(host.emitted).toEqual([]);

    editor.tiptap?.commands.insertContentAt(
      editor.tiptap.state.doc.content.size,
      '<p>typed <b>bold</b></p>'
    );
    await fixture.whenStable();
    const value = host.control.value;
    expect(value).toEqual({
      schemaVersion: 1,
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'from the form' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'typed ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
    expect(host.emitted.at(-1)).toEqual(value);
    expect(JSON.stringify(value)).not.toContain('<');
  });

  it('writes the empty document for null and honours the disabled state', async () => {
    const { fixture, host, editor, element } = await mount();
    host.control.setValue(null);
    await fixture.whenStable();
    expect(editor.tiptap?.getJSON()).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    host.control.disable();
    await fixture.whenStable();
    expect(editor.tiptap?.isEditable).toBe(false);
    expect(element.querySelector('.ship-rich-text-editor--disabled')).not.toBeNull();
    host.control.enable();
    await fixture.whenStable();
    expect(editor.tiptap?.isEditable).toBe(true);
  });

  it('sanitizes pasted HTML through the schema before it enters the document', async () => {
    const { fixture, host, editor } = await mount();
    const view = editor.tiptap?.view;
    if (!view) throw new Error('no view');
    view.dom.dispatchEvent(
      pasteEvent({
        html: '<script>alert(1)</script><p>safe <u>u</u><img src=x onerror=alert(1)></p><iframe src="https://evil.test"></iframe>',
      })
    );
    await fixture.whenStable();
    expect(host.control.value).toEqual({
      schemaVersion: 1,
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'safe u' }] }],
    });
  });

  it('uploads dropped images through the attachment uploader and inserts the object id', async () => {
    const { fixture, host, editor } = await mount();
    const upload = vi.fn(async (file: File) => ({ objectId: `obj-${file.name}` }));
    host.upload = upload;
    fixture.changeDetectorRef.markForCheck();
    await fixture.whenStable();
    const view = editor.tiptap?.view;
    if (!view) throw new Error('no view');
    const image = new File(['png'], 'chart.png', { type: 'image/png' });
    const text = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    // jsdom cannot resolve a drop position from coordinates, so the drop reaches the
    // editor's handler the way ProseMirror would call it after locating one.
    const handled = view.someProp('handleDrop', handle =>
      handle(view, dropEvent({ files: [image, text] }), Slice.empty, false)
    );
    expect(handled).toBe(true);
    expect(editor.uploading()).toBe(1);
    await vi.waitFor(() => expect(editor.uploading()).toBe(0));
    await fixture.whenStable();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(image);
    expect(host.control.value?.content).toContainEqual({
      type: 'attachment',
      attrs: { objectId: 'obj-chart.png', alt: 'chart.png' },
    });
    const figure = view.dom.querySelector('figure.ship-attachment');
    expect(figure?.getAttribute('data-object-id')).toBe('obj-chart.png');
  });

  it('reports a failed upload and leaves the document unchanged', async () => {
    const { fixture, host, editor } = await mount();
    host.upload = async () => {
      throw new Error('provider down');
    };
    fixture.changeDetectorRef.markForCheck();
    await fixture.whenStable();
    const view = editor.tiptap?.view;
    if (!view) throw new Error('no view');
    view.dom.dispatchEvent(
      pasteEvent({ files: [new File(['png'], 'a.png', { type: 'image/png' })] })
    );
    await vi.waitFor(() => expect(host.failures).toHaveLength(1));
    expect(host.control.value).toBeNull();
    expect(editor.insertAttachment('known', 'alt')).toBe(true);
    await fixture.whenStable();
    expect(host.control.value?.content).toContainEqual({
      type: 'attachment',
      attrs: { objectId: 'known', alt: 'alt' },
    });
    await vi.waitFor(() =>
      expect(view.dom.querySelector('figure.ship-attachment img')?.getAttribute('src')).toBe(
        'https://cdn.test/known'
      )
    );
  });
});
