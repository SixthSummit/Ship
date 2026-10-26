import {
  type AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  forwardRef,
  Input,
  inject,
  type OnDestroy,
  Output,
  signal,
} from '@angular/core';
import { type ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { type Content, Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import {
  emptyRichTextDocument,
  isRichTextDocument,
  type RichTextDocument,
} from './rich-text-document';
import {
  type CreateRichTextExtensionsOptions,
  createRichTextExtensions,
  normalizeRichTextDocument,
  type RichTextNodeLabel,
} from './rich-text-extensions';
import type { RichTextFieldPolicy } from './rich-text-field';

/** Uploads one dropped or pasted file to the field's attachment and answers the settled object id. */
export type RichTextAttachmentUploader = (file: File) => Promise<{ readonly objectId: string }>;

/** Strips what a browser clipboard may carry that the schema would otherwise have to refuse node by node. */
const UNSAFE_PASTE =
  /<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1>|<[^>]*\bon[a-z]+\s*=[^>]*>/giu;

/**
 * A form control for one declared rich text field. It emits the document
 * model (never HTML), builds its schema from the manifest policy so pasted
 * content outside the allowlist is dropped before it enters the document,
 * and uploads dropped or pasted images through the field's managed
 * attachment, inserting an `attachment` node that references the object id.
 */
@Component({
  selector: 'ship-rich-text-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => ShipRichTextEditorComponent),
      multi: true,
    },
  ],
  host: {
    class: 'ship-rich-text-editor',
    '[class.ship-rich-text-editor--disabled]': 'disabled()',
    '[class.ship-rich-text-editor--uploading]': 'uploading() > 0',
  },
  template: `<div class="ship-rich-text-editor__surface"></div>`,
  styles: `
    :host { display: block; }
    .ship-rich-text-editor__surface :is(.ProseMirror) { outline: none; min-height: 6rem; }
    .ship-attachment { margin: 0.5rem 0; }
    .ship-attachment img { max-width: 100%; display: block; }
    .ship-attachment--unavailable { min-height: 2rem; border: 1px dashed #999; }
    .ship-rich-text-node--atom { padding: 0 0.25em; border-radius: 0.25em; background: #eee; }
  `,
})
export class ShipRichTextEditorComponent implements ControlValueAccessor, AfterViewInit, OnDestroy {
  /** The field policy read from the manifest with `richTextFieldFromManifest`. */
  @Input({ required: true }) field!: RichTextFieldPolicy;
  /** Required to accept dropped or pasted images; without it they are ignored. */
  @Input() uploadAttachment: RichTextAttachmentUploader | undefined;
  /** Resolves a preview URL for an embedded object (for example through the application's read operation). */
  @Input() resolveAttachment: CreateRichTextExtensionsOptions['resolveAttachment'];
  /** Labels for declared atomic nodes, keyed by node name. */
  @Input() nodeLabels: Readonly<Record<string, RichTextNodeLabel>> = {};
  /** Emitted on every change with the normalized document. */
  @Output() readonly documentChange = new EventEmitter<RichTextDocument>();
  /** Emitted when an upload fails; the file is not inserted. */
  @Output() readonly uploadError = new EventEmitter<{
    readonly file: File;
    readonly error: unknown;
  }>();

  readonly disabled = signal(false);
  readonly uploading = signal(0);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private editor: Editor | undefined;
  private pendingValue: RichTextDocument | undefined;
  private onChange: (value: RichTextDocument) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  /** The underlying TipTap editor, for toolbars; undefined before the view exists. */
  get tiptap(): Editor | undefined {
    return this.editor;
  }

  ngAfterViewInit(): void {
    const surface = this.host.nativeElement.querySelector<HTMLElement>(
      '.ship-rich-text-editor__surface'
    );
    if (!surface) return;
    const policy = this.field;
    const resolveAttachment = this.resolveAttachment;
    this.editor = new Editor({
      element: surface,
      extensions: createRichTextExtensions(policy, {
        ...(resolveAttachment === undefined ? {} : { resolveAttachment }),
        nodeLabels: this.nodeLabels,
      }),
      content: (this.pendingValue ??
        emptyRichTextDocument(policy.schemaVersion)) as unknown as Content,
      editable: !this.disabled(),
      editorProps: {
        attributes: { class: 'ship-rich-text-editor__content' },
        transformPastedHTML: html => html.replace(UNSAFE_PASTE, ''),
        handlePaste: (view, event) => this.handleFiles(view, event.clipboardData?.files),
        handleDrop: (view, event, _slice, moved) =>
          moved
            ? false
            : this.handleFiles(
                view,
                event.dataTransfer?.files,
                view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
              ),
      },
      onUpdate: ({ editor }) => {
        const document = normalizeRichTextDocument(policy, editor.getJSON());
        this.onChange(document);
        this.documentChange.emit(document);
      },
      onBlur: () => this.onTouched(),
    });
    this.pendingValue = undefined;
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
    this.editor = undefined;
  }

  writeValue(value: unknown): void {
    const document = isRichTextDocument(value)
      ? value
      : emptyRichTextDocument(this.field.schemaVersion);
    if (!this.editor) {
      this.pendingValue = document;
      return;
    }
    this.editor.commands.setContent(document as unknown as Content, { emitUpdate: false });
  }

  registerOnChange(fn: (value: RichTextDocument) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
    this.editor?.setEditable(!isDisabled);
  }

  /** Inserts an already uploaded object at the selection; what toolbars call after their own upload. */
  insertAttachment(objectId: string, alt?: string): boolean {
    if (!this.editor || this.field.attachment === undefined) return false;
    return this.editor
      .chain()
      .focus()
      .insertContent({ type: 'attachment', attrs: { objectId, alt: alt ?? null } })
      .run();
  }

  private handleFiles(view: EditorView, files: FileList | undefined, position?: number): boolean {
    const upload = this.uploadAttachment;
    if (!files || files.length === 0 || upload === undefined) return false;
    if (this.field.attachment === undefined) return false;
    const images = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (images.length === 0) return false;
    for (const file of images) {
      this.uploading.update(count => count + 1);
      upload(file)
        .then(({ objectId }) => {
          if (!this.editor || view.isDestroyed) return;
          const node = view.state.schema.nodes['attachment'];
          if (!node) return;
          const attachment = node.create({ objectId, alt: file.name || null });
          const at = position ?? view.state.selection.to;
          view.dispatch(view.state.tr.insert(at, attachment).scrollIntoView());
        })
        .catch((error: unknown) => this.uploadError.emit({ file, error }))
        .finally(() => this.uploading.update(count => count - 1));
    }
    return true;
  }
}
