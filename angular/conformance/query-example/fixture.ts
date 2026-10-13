import { signal } from '@angular/core';
import {
  OperationAbortedError,
  type OperationClient,
  type OperationDefinition,
  type OperationResultOf,
} from '@sixthsummit/ship-angular/operations';

export interface Item {
  readonly id: number;
  readonly title: string;
}
export interface Page {
  readonly items: readonly Item[];
  readonly next: number | null;
}
export type ExampleContract = {
  list: OperationDefinition<{ cursor: number | null }, { 200: Page }, never>;
  detail: OperationDefinition<{ id: number }, { 200: Item }, never>;
  edit: OperationDefinition<Item, { 200: Item }, 'REJECTED'>;
};

/** Controlled browser-safe fixture. No URL, credentials, or production service. */
export function createExampleFixture() {
  const counters = signal({ list: 0, detail: 0, edit: 0 });
  const delayMs = signal(40);
  const rejectNextEdit = signal(false);
  const items = new Map<number, Item>([
    [1, { id: 1, title: 'First' }],
    [2, { id: 2, title: 'Second' }],
  ]);
  const client: OperationClient<ExampleContract> = {
    async call(id, input, options) {
      counters.update(value => ({ ...value, [id]: value[id] + 1 }));
      await new Promise<void>((resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new OperationAbortedError());
          return;
        }
        const cleanup = () => options?.signal?.removeEventListener('abort', abort);
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, delayMs());
        const abort = () => {
          clearTimeout(timer);
          cleanup();
          reject(new OperationAbortedError());
        };
        options?.signal?.addEventListener('abort', abort, { once: true });
      });
      const headers = { headers: {}, requestId: `fixture.${id}.${counters()[id]}` };
      let result: OperationResultOf<ExampleContract, keyof ExampleContract>;
      if (id === 'list') {
        const { cursor } = input as { cursor: number | null };
        const start = cursor ?? 1;
        result = {
          ok: true,
          status: 200,
          data: { items: [items.get(start)!], next: start === 1 ? 2 : null },
          headers,
        };
      } else if (id === 'detail') {
        result = { ok: true, status: 200, data: items.get((input as { id: number }).id)!, headers };
      } else if (rejectNextEdit()) {
        rejectNextEdit.set(false);
        result = {
          ok: false,
          status: 409,
          error: { code: 'REJECTED', declared: true, message: 'Controlled edit rejection' },
          headers,
        };
      } else {
        const item = input as Item;
        items.set(item.id, { ...item });
        result = { ok: true, status: 200, data: { ...item }, headers };
      }
      // Runtime operation dispatch narrows the controlled fixture's result union.
      return result as OperationResultOf<ExampleContract, typeof id>;
    },
  };
  return { client, counters: counters.asReadonly(), delayMs, rejectNextEdit };
}
