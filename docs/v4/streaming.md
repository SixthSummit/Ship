# Ship streaming wire contract v1 (SSE) — canonical, both server (ship-api SAPI-110) and client (ship-angular) implement exactly this

## Declaration (kernel)
transport.response = { mode: "stream", framing: "sse", frame: RuntimeSchema, terminal?: RuntimeSchema, heartbeatMs: number, maxDurationMs: number, maxFrames: number }
Constraints: transaction must be "none"; no idempotency declaration; no `cache` declaration (streams bypass the read cache, ADR-0019); maxDurationMs and maxFrames required.

## Manifest projection (ship-contract)
operations[id].response = { mode: "stream", framing: "sse", frame: <schemaRef>, terminal?: <schemaRef>, limits: { heartbeatMs, maxDurationMs, maxFrames } }
Non-stream operations keep their existing response projection. The frame/terminal schema refs participate in the manifest fingerprint.

## HTTP
Request: the operation's normal method/path/input; client sends `Accept: text/event-stream`.
Errors BEFORE the first frame: the normal ADR-0005 JSON error envelope with its normal status (401/403/404/422/...). The client must branch on Content-Type: `application/json` => error envelope; `text/event-stream` => stream.
Success: status 200; headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Ship-Stream: sse/1`, plus the usual request-id header.

## SSE events (UTF-8, `\n\n` terminated, per WHATWG EventSource framing)
1. Frame:      `id: <seq>` `event: frame`    `data: <JSON of frame>`        — seq is a 1-based monotonically increasing integer per stream.
2. Terminal:   `id: <seq>` `event: terminal` `data: <JSON of terminal | null>` — final event; server closes after it.
3. Error:      `id: <seq>` `event: error`    `data: {"code":string,"status":number,"message":string,"details"?:unknown}` — final event; same shape as the JSON error envelope's `error` object; server closes after it.
4. Heartbeat:  a comment line `: hb <unix-ms>` every heartbeatMs while no frame has been sent in that interval. Clients ignore comments.
Exactly one of terminal|error ends a successful-start stream. A connection closing without either is a transport failure; the client reports `STREAM_INTERRUPTED` locally.

## Stable error codes in terminal error frames
STREAM_MAX_DURATION_EXCEEDED (status 504), STREAM_MAX_FRAMES_EXCEEDED (status 500), declared operation error codes (their declared status), INTERNAL_ERROR (500, generic message, no internal detail).

## Cancellation
Client abort closes the request; server aborts the handler `signal`; no further events. Server releases resources within one heartbeat interval.

## Structural client handle (ship-contract) and ship-angular createStream
{ frames: AsyncIterable<Frame>; terminal: Promise<Terminal | undefined>; abort(): void; status: "connecting" | "open" | "closed" | "error" | "aborted"; error?: { code, status, message } }
ship-angular exposes the same as signals: frames (latest + array or callback), terminal, status, error; SSR renders nothing and opens no request.

---

## ship-api implementation notes (normative for this repository; ShipAngular reads the contract above)

These notes pin down every byte and shape the contract above leaves to the implementer. They are frozen with [ADR-0016](../rearchitecture/decisions/0016-streaming-response-representation.md).

### Declaration as implemented

```ts
import { http } from "@sixthsummit/ship-hono";

defineOperation({
  id: "reports.progress",
  transport: http.post("/reports/:reportId/progress", {
    response: {
      mode: "stream",
      framing: "sse",          // the only framing today
      frame: progressFrame,    // Standard Schema; every emit() is validated against it
      heartbeatMs: 15_000,
      maxDurationMs: 60_000,
      maxFrames: 1_000,
    },
  }),
  input: { params, body },
  output: { 200: summarySchema }, // the terminal value schema
  successStatus: 200,
  transaction: "none",
  handler: async ({ input, services, context, stream }) => {
    for (const step of steps) {
      if (stream.signal.aborted) break;
      await stream.emit({ step, percent });   // resolves once the reader accepted the frame
    }
    return { steps: steps.length };           // becomes the terminal event
  },
});
```

- `terminal` is **not** a separate slot in the declaration: the terminal value is the operation's single `200` output, which keeps the kernel's status-indexed results and typed `successStatus` unchanged. The manifest still publishes it as `response.terminal`. To stream without a meaningful terminal value declare `output: { 200: z.null() }` and return `null`; the terminal event then carries `data: null`.
- Kernel diagnostics: `SHIP_OPERATION_STREAM_TRANSACTION_FORBIDDEN`, `SHIP_OPERATION_STREAM_LIMIT_MISSING` (one per missing `heartbeatMs`/`maxDurationMs`/`maxFrames`), `SHIP_OPERATION_STREAM_OUTPUT_INVALID`, `SHIP_OPERATION_STREAM_IDEMPOTENCY_FORBIDDEN`, `SHIP_OPERATION_STREAM_CACHE_FORBIDDEN` (a stream never reads from or writes to the declared read cache). Structural mistakes in the declaration fail `defineOperation` with `SHIP_OPERATION_TRANSPORT_INVALID` at `transport.response`.
- Direct execution: `executor.run(id, input, { stream: { write(frame) {} } })`; the run resolves to `{ ok: true, status: 200, data: <terminal> }` or a declared failure result. Running a streaming operation without a sink throws `SHIP_OPERATION_STREAM_SINK_MISSING`.

### Manifest shape as emitted (`ClientContractOperation`)

```jsonc
{
  "id": "reports.progress",
  "input": { "params": { /* ProjectedContractSchema */ }, "body": { /* ... */ } },
  "success": [{ "status": 200, "vendor": "zod", "jsonSchema": { /* terminal */ } }],
  "errors": [ /* declared errors, unchanged */ ],
  "access": { "kind": "permissions", "mode": "all", "permissions": ["reports:notify"] },
  "transaction": "none",
  "transport": {
    "kind": "http",
    "binding": "POST /reports/:reportId/progress",
    "metadata": {
      "method": "POST",
      "path": "/reports/:reportId/progress",
      "response": "stream",
      "contentType": "text/event-stream; charset=utf-8",
      "requestBody": { "mode": "json" }
    }
  },
  "response": {
    "mode": "stream",
    "framing": "sse",
    "frame":    { "vendor": "zod", "jsonSchema": { /* frame */ }, "codec": "optional.codec.id" },
    "terminal": { "vendor": "zod", "jsonSchema": { /* same as success[0] */ } },
    "limits":   { "heartbeatMs": 15000, "maxDurationMs": 60000, "maxFrames": 1000 }
  }
}
```

- `transport.metadata.response === "stream"` if and only if `response` is present; the client rejects a manifest where they disagree (`SHIP_CLIENT_CONTRACT_INVALID`).
- `response.terminal` is always emitted by this projection (it equals `success[0]` without `status`). Clients must still treat it as optional.
- `frame` and `terminal` are `ProjectedContractSchema` values (`vendor`, `jsonSchema`, optional `codec`) exactly like input and success schemas, so they participate in `fingerprint` and codecs apply to decoded frames and terminal values.
- OpenAPI: the `200` response uses media type `text/event-stream; charset=utf-8` with `schema: { type: "string", format: "event-stream" }`, headers `X-Request-Id` and `X-Ship-Stream`, and extensions `x-ship-stream-framing`, `x-ship-stream-frame`, `x-ship-stream-terminal`, `x-ship-stream-limits`.

### Wire bytes as emitted

- Response headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store`, `X-Ship-Stream: sse/1`, `X-Request-Id: <id>`.
- Field order inside every event is exactly `id`, `event`, `data`, each terminated by `\n`, followed by one blank line (`\n\n` after `data`). `data` is always a single line because it is `JSON.stringify` output.

```text
id: 1\nevent: frame\ndata: {"step":1,"percent":50}\n\n
id: 2\nevent: frame\ndata: {"step":2,"percent":100}\n\n
id: 3\nevent: terminal\ndata: {"steps":2}\n\n
```

- Error event (final): `id: <seq>\nevent: error\ndata: {"code":"RENDER_STEP_FAILED","status":409,"message":"Report rendering failed","details":{"step":3}}\n\n`. `details` is omitted when the declared error has none. The generic frame is exactly `{"code":"INTERNAL_ERROR","status":500,"message":"An unexpected error occurred"}`.
- Heartbeat: `: hb <unix-ms>\n\n` (comment line plus one blank line). It is written only when no event has been written for `heartbeatMs` and no event write is pending. `<unix-ms>` is `Date.now()` on the server.
- `seq` counts every `frame`, `terminal`, and `error` event from 1; heartbeats do not consume a sequence number.
- Before the first frame everything is unary: declared errors, `401`/`403`, validation, `INTERNAL_SERVER_ERROR` (500), and the duration budget (`504 STREAM_MAX_DURATION_EXCEEDED`) are JSON envelopes. A handler that returns without emitting still opens the stream and sends only the `terminal` event.
- After the first frame every outcome is exactly one final event. Exceeding `maxFrames` (the `maxFrames + 1`th `emit`) or `maxDurationMs` aborts the handler signal, rejects the pending `emit` with an error whose `code` is the limit code, and writes the limit error frame regardless of what the handler returns afterwards.
- Client abort (request signal or body cancellation) aborts the handler signal immediately, rejects the next `emit`, and writes nothing further. Handlers are expected to observe `stream.signal`.
- Backpressure: at most one frame is in flight; `emit` resolves when the response reader has pulled the frame.

### Structural client (`@sixthsummit/ship-contract`)

`client.call(id, input, options?)` returns the handle **synchronously** for operations whose manifest carries `response.mode === "stream"` (unary operations keep returning a promise). The request carries `Accept: text/event-stream`.

```ts
interface OperationStreamHandle<TFrame, TTerminal> {
  readonly frames: AsyncIterable<TFrame>;            // single pass; ends on terminal, error, interruption, or abort
  readonly terminal: Promise<TTerminal | undefined>; // undefined after error, interruption, or abort
  abort(): void;                                     // status becomes "aborted"; aborts the fetch
  readonly status: "connecting" | "open" | "closed" | "error" | "aborted";
  readonly error?: { code: string; status: number; message: string; details?: unknown };
  readonly requestId?: string;                       // from X-Request-Id once headers arrive
  readonly metadata?: { requestId: string; headers: Record<string, string> };
}
```

- `application/json` responses (errors before the first frame) become `status: "error"` with `error` taken from the envelope and the HTTP status; the request ID is still recorded.
- A connection that ends without `terminal`/`error`, a network failure, a non-stream body, or a malformed final event sets `error.code = "STREAM_INTERRUPTED"` with `status: 0`.
- `frames` and `terminal` reject only for client-side misuse (`OperationClientError`: invalid input, missing codec, invalid contract); they never reject for server or transport outcomes.
- Unknown event names are ignored for forward compatibility; `id` values are not resumed (no `Last-Event-ID`).

### Compatibility

The compatibility `streamSSE`/`streamLLM` helpers in `@sixthsummit/ship-api` are unchanged. A compatibility route that writes this layout through `streamSSE` produces byte-identical output to the kernel mode (locked by `packages/core/src/test/parity/stream.parity.test.ts`). `libraries/ai` exports `streamLLM(stream, events)` to pipe an `LLMProvider.streamComplete()` iterator through a streaming operation's `emit`.
