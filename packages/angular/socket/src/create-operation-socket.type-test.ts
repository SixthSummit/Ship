import type { OperationClient } from '@sixthsummit/ship-angular/operations';
import { createOperationSocket, type OperationSocketBinding } from './create-operation-socket';

interface Contract {
  readonly 'socket.ticket': {
    readonly input: { readonly body: { readonly room: string } };
    readonly success: { readonly 201: { readonly ticket: string } };
    readonly errors: 'DENIED';
    readonly transport: 'http';
  };
  readonly 'socket.connect': {
    readonly input: { readonly query: { readonly room: string } };
    readonly success: { readonly 101: { readonly event: string } };
    readonly errors: 'CLOSED';
    readonly transport: 'socket';
  };
}

interface ClientMessage {
  readonly command: string;
}

declare const client: OperationClient<Contract>;
declare const binding: OperationSocketBinding<
  Contract,
  'socket.connect',
  ClientMessage,
  'socket.ticket'
>;

const socket = createOperationSocket(client, binding, {
  allowedSocketOrigins: ['wss://socket.example.test'],
});
void socket.connect({ query: { room: 'updates' } });
void socket.send({ command: 'subscribe' });
const event: { readonly event: string } | undefined = socket.messages()[0];
void event;

// @ts-expect-error Socket input locations are contract-derived.
void socket.connect({ body: { room: 'updates' } });

// @ts-expect-error Outgoing client messages use their generated codec type.
void socket.send({ event: 'wrong-direction' });

// @ts-expect-error HTTP operation IDs cannot define a socket binding.
const invalid: OperationSocketBinding<Contract, 'socket.ticket', ClientMessage> = binding;
void invalid;
