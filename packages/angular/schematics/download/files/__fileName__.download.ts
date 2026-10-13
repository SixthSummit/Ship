import { Injectable, type OnDestroy } from '@angular/core';
import {
  createOperationDownload,
  type OperationDownload,
} from '@sixthsummit/ship-angular/download';
import { <%= bindingName %> } from '<%= bindingPackage %>';
import type { <%= contractType %> } from '<%= contractPackage %>';
import { injectAppShipRequestPolicy } from '<%= apiImport %>';

const OPERATION = '<%= operationId %>' as const;

@Injectable({ providedIn: 'root' })
export class <%= name %>Download implements OnDestroy {
  private readonly policy = injectAppShipRequestPolicy();

  readonly download: OperationDownload<<%= contractType %>, typeof OPERATION, '<%= representation %>'> =
    createOperationDownload(this.policy, OPERATION, <%= bindingName %>, {
      representation: '<%= representation %>',
    });

  ngOnDestroy(): void {
    this.download.destroy();
  }
}
