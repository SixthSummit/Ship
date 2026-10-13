import type { OperationRequestPolicy } from '@sixthsummit/ship-angular/operations';
import { createOperationStream, type OperationStreamBinding } from './create-operation-stream';

interface Contract {
  readonly 'events.watch': {
    readonly input: { readonly query: { readonly channel: string } };
    readonly success: { readonly 200: { readonly value: string } };
    readonly errors: 'DENIED';
    readonly transport: 'stream';
  };
  readonly 'events.get': {
    readonly input: { readonly params: { readonly eventId: string } };
    readonly success: { readonly 200: { readonly value: string } };
    readonly errors: 'NOT_FOUND';
    readonly transport: 'http';
  };
}

declare const policy: OperationRequestPolicy<Contract>;
declare const binding: OperationStreamBinding<Contract, 'events.watch'>;

const stream = createOperationStream(policy, 'events.watch', binding);
void stream.start({ query: { channel: 'updates' } });
const event: { readonly value: string } | undefined = stream.events()[0];
void event;

// @ts-expect-error Unary operation IDs cannot be streamed.
createOperationStream(policy, 'events.get', binding);

// @ts-expect-error Stream input locations and fields are contract-derived.
void stream.start({ params: { channel: 'updates' } });
