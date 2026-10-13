import { ChangeDetectionStrategy, Component, type OnDestroy } from '@angular/core';
import type { InputOf } from '@sixthsummit/ship-angular/operations';
import {
  createOperationUpload,
  type OperationUpload,
} from '@sixthsummit/ship-angular/upload';
import { <%= bindingName %> } from '<%= bindingPackage %>';
import type { <%= contractType %> } from '<%= contractPackage %>';
import { injectAppShipRequestPolicy } from '<%= apiImport %>';

const OPERATION = '<%= operationId %>' as const;
const FILE_FIELD = '<%= fieldName %>';

@Component({
  selector: '<%= selector %>',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input
      type="file"
      [attr.accept]="acceptedMediaTypes"
      (change)="onFileSelected($event)"
      [disabled]="upload.pending()"
    />

    @if (upload.status() === 'uploading') {
      <progress [value]="upload.progress()" max="1"></progress>
      <button type="button" (click)="upload.cancel()">Cancel</button>
    }

    @if (upload.failure(); as failure) {
      <p class="error">{{ failure.error.message }}</p>
    } @else if (upload.error(); as error) {
      <p class="error">{{ error.message }}</p>
    }
  `,
})
export class <%= name %>Component implements OnDestroy {
  private readonly policy = injectAppShipRequestPolicy();
  readonly acceptedMediaTypes = <%= bindingName %>.fields
    .find(field => field.field === FILE_FIELD)
    ?.acceptedMediaTypes?.join(',');
  readonly upload: OperationUpload<<%= contractType %>, typeof OPERATION> = createOperationUpload(
    this.policy,
    OPERATION,
    <%= bindingName %>
  );

  onFileSelected(event: Event): void {
    const element = event.target as HTMLInputElement;
    const file = element.files?.[0];
    if (file === undefined) return;
    void this.upload.start({
      body: { <%= fieldName %>: file },
    } satisfies InputOf<<%= contractType %>, typeof OPERATION>);
  }

  ngOnDestroy(): void {
    this.upload.destroy();
  }
}
