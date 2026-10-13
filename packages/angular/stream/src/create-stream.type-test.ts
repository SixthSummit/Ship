import { createStream } from './create-stream';
import type { StreamFrameOf, StreamTerminalOf } from './ship-stream-contract';
import type { ShipStreamManifest } from './ship-stream-manifest';

interface Contract {
  readonly operations: {
    readonly 'agent.run': {
      readonly transport: 'stream';
      readonly input: {
        readonly params: { readonly agentId: string };
        readonly body: { readonly prompt: string };
      };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: {
          readonly frame: { readonly delta: string };
          readonly terminal: { readonly tokens: number };
        };
      };
    };
    readonly 'agent.get': {
      readonly transport: 'http';
      readonly input: { readonly params: { readonly agentId: string } };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly agentId: string };
      };
    };
  };
}

declare const manifest: ShipStreamManifest;

const run = createStream<Contract, 'agent.run'>({
  manifest,
  operation: 'agent.run',
  input: { params: { agentId: 'agent-1' }, body: { prompt: 'hello' } },
  baseUrl: 'https://api.example.test',
});

const frame: { readonly delta: string } | undefined = run.latest();
const terminal: { readonly tokens: number } | undefined = run.terminal();
const seq: number = run.seq();
void frame;
void terminal;
void seq;

// The manifest-typed overload infers Frame and Terminal from the contract.
const inferredFrame: StreamFrameOf<Contract, 'agent.run'> = { delta: 'a' };
const inferredTerminal: StreamTerminalOf<Contract, 'agent.run'> = { tokens: 1 };
void inferredFrame;
void inferredTerminal;

createStream<Contract, 'agent.run'>(
  {
    manifest,
    operation: 'agent.run',
    input: { params: { agentId: 'agent-1' }, body: { prompt: 'hello' } },
    baseUrl: 'https://api.example.test',
  },
  { onFrame: (value: { readonly delta: string }) => void value }
);

const mistypedInput = {
  manifest,
  operation: 'agent.run',
  input: { params: { agentId: 'agent-1' }, body: { question: 'hello' } },
  baseUrl: 'https://api.example.test',
} as const;

// @ts-expect-error Stream input locations and fields are contract-derived.
createStream<Contract, 'agent.run'>(mistypedInput);

const unaryReference = {
  manifest,
  operation: 'agent.get',
  input: { params: { agentId: 'agent-1' } },
  baseUrl: 'https://api.example.test',
} as const;

// @ts-expect-error Unary operation IDs cannot be streamed.
createStream<Contract, 'agent.get'>(unaryReference);

const anonymous = createStream<{ readonly value: number }>('https://api.example.test/events');
const value: { readonly value: number } | undefined = anonymous.latest();
void value;
