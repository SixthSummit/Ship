# Streaming operations

`createStream()` from `@sixthsummit/ship-angular/stream` consumes a ShipAPI operation
declared with `response.mode: "stream"`. It speaks the canonical SSE wire contract that
ShipAPI implements on the server side, so frame and terminal types come from the contract
rather than from hand-written generics.

The older `createOperationStream()` (binding-driven, reconnect-capable) and the root
`createStream()` (URL/`hc()` thunk) are unchanged and remain supported. Use the
manifest-typed `createStream()` for any operation ShipAPI projects as a stream.

## The wire contract in one page

| Concern        | Contract                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Request        | The operation's declared method and path, its input, and `Accept: text/event-stream`                                  |
| Success        | `200` with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Ship-Stream: sse/1`        |
| Failure        | Before the first frame: the normal JSON error envelope with its normal status. The client branches on `Content-Type`. |
| Frame event    | `id: <seq>` / `event: frame` / `data: <JSON frame>`; `seq` is 1-based and monotonic                                   |
| Terminal event | `id: <seq>` / `event: terminal` / `data: <JSON terminal \| null>`; the server closes after it                         |
| Error event    | `id: <seq>` / `event: error` / `data: {"code","status","message","details"?}`; the server closes after it             |
| Heartbeat      | A comment line `: hb <unix-ms>`; clients ignore it                                                                    |
| Interrupted    | A close with neither terminal nor error is reported locally as `STREAM_INTERRUPTED`                                   |

Exactly one of `terminal` or `error` ends a stream that started successfully.

## Declaring the manifest

The manifest ShipAPI generates already carries everything the client needs. A stream
operation projects as:

```jsonc
{
  "id": "agent.run",
  "method": "POST",
  "path": "/agents/:agentId/run",
  "success": [{ "status": 200 }],
  "errors": [{ "code": "AGENT_NOT_FOUND", "status": 404 }],
  "response": {
    "mode": "stream",
    "framing": "sse",
    "frame": { "$ref": "#/schemas/AgentDelta" },
    "terminal": { "$ref": "#/schemas/AgentUsage" },
    "limits": { "heartbeatMs": 15000, "maxDurationMs": 600000, "maxFrames": 4096 },
  },
}
```

The same object is the one you already pass to `createShipApiClientExecutor()`; it is
structurally a `ShipStreamManifest`, so no cast or second artifact is needed.

## Typing the frame and terminal

A stream operation's success data projects both payloads:

```ts
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
```

`StreamFrameOf<TContract, TId>` and `StreamTerminalOf<TContract, TId>` select them. A
contract that declares no `terminal` member yields `undefined`, matching the optional
terminal schema on the wire.

ShipAPI currently emits `terminal` on every stream operation (it equals the operation's
`output[200]` schema), but the client still treats it as optional: a manifest without it
resolves normally, and a handler that returns without emitting sends only a terminal event,
which may carry `data: null` and decodes to `undefined`.

## Using it in a component

```ts
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { createStream } from '@sixthsummit/ship-angular/stream';
import { environment } from '../environments/environment';
import { APP_MANIFEST, type AppContract } from '../api/manifest';

@Component({
  selector: 'app-agent-run',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (run.status() === 'error') {
      <p role="alert">{{ run.error()?.message }}</p>
    }
    @for (frame of run.frames(); track $index) {
      <span>{{ frame.delta }}</span>
    }
    @if (run.terminal(); as usage) {
      <footer>{{ usage.tokens }} tokens</footer>
    }
  `,
})
export class AgentRunComponent {
  private readonly manifest = inject(APP_MANIFEST);

  protected readonly run = createStream<AppContract, 'agent.run'>({
    manifest: this.manifest,
    operation: 'agent.run',
    input: { params: { agentId: 'agent-1' }, body: { prompt: 'Summarize this' } },
    baseUrl: environment.apiBaseUrl,
  });
}
```

## The handle

| Member       | Type                                   | Meaning                                                            |
| ------------ | -------------------------------------- | ------------------------------------------------------------------ |
| `frames()`   | `Signal<readonly Frame[]>`             | Frames received so far, bounded by the declared `limits.maxFrames` |
| `latest()`   | `Signal<Frame \| undefined>`           | The most recent frame                                              |
| `terminal()` | `Signal<Terminal \| undefined>`        | The decoded terminal payload                                       |
| `status()`   | `Signal<ShipStreamStatus>`             | `idle \| connecting \| open \| closed \| error \| aborted`         |
| `error()`    | `Signal<ShipStreamError \| undefined>` | `{ code, status, message, details? }`                              |
| `seq()`      | `Signal<number>`                       | The last SSE `id:` sequence number; `0` before the first event     |
| `abort()`    | `() => void`                           | Cancels the request and moves to `aborted`                         |

A successful stream walks `connecting → open → closed`. `onFrame` is available for
consumers that want each frame without retained history.

## Errors

Application failures that happen before the first frame arrive as the ordinary JSON error
envelope and are decoded with the same parser the unary client uses, so `error()` carries
the declared code and status (`AGENT_NOT_FOUND`, `401`, …). Failures after the stream has
started arrive as an `error` event with the contract's stable codes:
`STREAM_MAX_DURATION_EXCEEDED` (504), `STREAM_MAX_FRAMES_EXCEEDED` (500), a declared
operation error code, or `INTERNAL_ERROR` (500).

Three codes are reported locally, for failures the server never got to name. They always
carry `status: 0`, because no server named them — a non-zero `status` on `error()` always
came from the wire:

- `STREAM_INTERRUPTED` — the connection closed without a terminal or error event;
- `STREAM_TRANSPORT_FAILED` — the request never produced a response;
- `STREAM_PROTOCOL_VIOLATION` — a response arrived but violated the framing.

A duration budget that expires **before** the first frame is a pre-first-frame failure, so
it arrives as the JSON envelope with `504 STREAM_MAX_DURATION_EXCEEDED` rather than as an
error event. `details` is present on an error only when the server sent it; the generic
failure frame is exactly
`{"code":"INTERNAL_ERROR","status":500,"message":"An unexpected error occurred"}`.

## Cancellation

`abort()` closes the request; the server aborts its handler signal and releases resources
within one heartbeat interval. Pass `signal` to tie a stream to an outer lifetime instead.
An abort before the first frame settles on the handle as `status() === 'aborted'`; nothing
is thrown and no promise rejects, so there is no rejection to catch.

## Server rendering

Under SSR, `createStream()` returns a handle in `idle` with empty frames and opens no
request. Platform detection follows `PLATFORM_ID` when an injection context exists; pass
`platform: 'server' | 'browser'` to force it in a test.

## Without a manifest

For an endpoint ShipAPI has not projected yet, pass a URL or an explicit request and
supply the types yourself:

```ts
const events = createStream<MyFrame, MyTerminal>({
  url: 'https://api.example.test/events',
  method: 'GET',
});
```

The wire contract, status transitions, and error codes are identical; only the typing and
the request construction differ.
