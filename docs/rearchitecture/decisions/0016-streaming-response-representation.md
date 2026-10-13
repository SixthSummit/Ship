# ADR-0016: Declare streaming responses as validated frames over SSE

- **Status:** Accepted
- **Date:** 2026-09-18
- **Scope:** Streaming response declaration, handler seam, HTTP framing, client manifest, and structural client
- **Related:** [ADR-0003](./0003-operation-results-and-errors.md) · [ADR-0005](./0005-http-wire-and-representation-contract.md) · [ADR-0009](./0009-client-safe-contract-projections.md) · [ADR-0011](./0011-explicit-bounded-request-bodies.md) · [Streaming wire contract](../../v4/streaming.md)

## Context

ADR-0003 and ADR-0005 deliberately limited the first operation kernel to unary `json`, `text`, and `binary` representations and stated that streaming protocols need a separate explicit transport rather than an overloaded binary mode. Consumers still stream: progress for long-running work, LLM token deltas, and live tallies. Today those routes bypass the kernel through the compatibility `streamSSE`/`streamLLM` helpers, so their frame shapes, limits, access policy, and error behavior are invisible to the graph, the client manifest, OpenAPI, and ShipAngular.

A streaming operation also has failure modes a unary one does not: the HTTP status has already been sent when a later failure occurs, a client can disconnect mid-stream, a handler can run or emit without bound, and a proxy can drop an idle connection. Leaving those to each handler recreates the drift the kernel was built to remove.

## Decision

An HTTP operation may declare one streaming response on its transport:

```ts
transport: http.post("/reports/:reportId/progress", {
  response: { mode: "stream", framing: "sse", frame, heartbeatMs, maxDurationMs, maxFrames },
}),
output: { 200: terminalSchema },
successStatus: 200,
transaction: "none",
```

- `frame` is the Standard Schema every emitted frame is validated against. The terminal value is the operation's single declared `200` output, so the existing status-indexed result model, direct executor, and success projection stay unchanged; `compileApp` reports `SHIP_OPERATION_STREAM_OUTPUT_INVALID` for any other output shape.
- The kernel owns the declaration and its invariants: streams must be `transaction: "none"` (`SHIP_OPERATION_STREAM_TRANSACTION_FORBIDDEN`), must declare `heartbeatMs`, `maxDurationMs`, and `maxFrames` (`SHIP_OPERATION_STREAM_LIMIT_MISSING`), and may not carry an idempotency declaration (`SHIP_OPERATION_STREAM_IDEMPOTENCY_FORBIDDEN`). The graph projects the declaration without schemas.
- Handlers receive `stream.emit(frame)` and `stream.signal` in addition to `input`, `services`, and `context`. `emit` validates the frame and resolves only when the adapter has accepted it; the handler returns the terminal value. Handlers never touch the raw response. Direct execution supplies a sink through `OperationRunOptions.stream`, so streaming operations remain testable without HTTP.
- The Hono adapter owns framing and resources. Authentication, access, and input parsing run before any handler work. Failures before the first frame use the ADR-0005 JSON envelope and HTTP status. The response becomes `200 text/event-stream` on the first frame; every later outcome is exactly one `terminal` or `error` event. The adapter applies reader backpressure to `emit`, writes heartbeat comments while idle, aborts the handler signal on client disconnect, and terminates with stable `STREAM_MAX_DURATION_EXCEEDED` or `STREAM_MAX_FRAMES_EXCEEDED` error frames. Unexpected failures after the first frame become a generic `INTERNAL_ERROR` frame; the original error goes to the unexpected-error observer only.
- The client manifest marks the operation with `response: { mode, framing, frame, terminal, limits }`, both schemas participate in the fingerprint, and OpenAPI records the `text/event-stream` response with `x-ship-stream-*` extensions. The structural client returns a synchronous `{ frames, terminal, abort, status, error }` handle built on Fetch and `ReadableStream` with an incremental WHATWG SSE parser, so browsers need no additional runtime.
- `sse` is the only framing today. The declaration names the framing explicitly so a later framing can be added without changing the handler contract.

The exact event layout, headers, error codes, and manifest shape are frozen in [docs/v4/streaming.md](../../v4/streaming.md); ShipAngular implements against that document.

## Consequences

- Streams are ordinary operations: they share access policy, input validation, declared errors, graph diagnostics, contract fingerprints, and direct execution with unary operations.
- A consumer migrating a compatibility `streamSSE` route that already writes the Ship layout produces byte-identical SSE from the kernel mode; the parity test locks this.
- Every stream has an explicit lifetime and frame budget, so an abandoned or runaway handler cannot hold a worker indefinitely.
- The response begins only at the first frame (or completion). A handler that runs long before emitting delays the client's headers; consumers that need immediate acknowledgement emit an early frame.
- Frames are bounded by the reader, not buffered; a slow client slows the producer. Producers that must not block need their own queue and drop policy.
- Operation response headers and `respond()` statuses have no meaning after the stream opens and are ignored for streaming operations.
- WebSocket, NDJSON, and bidirectional protocols remain outside this decision.

## Rejected alternatives

### Return a `ReadableStream` through the `binary` mode

Rejected because the frame shape, terminal value, heartbeat, limits, and error framing would be invisible to the contract and the adapter could not own cancellation or terminal errors.

### Start the SSE response before the handler runs

Rejected because declared failures before the first frame (tenant denial, validation of derived state) could then only be reported inside the stream, losing the unary status contract that clients and proxies rely on.

### Put the terminal schema inside the stream declaration

Rejected because the kernel's status-indexed output model and typed `successStatus` already express exactly one terminal value; a second schema slot would duplicate it. The manifest still surfaces `response.terminal` for clients.

### Throw from the client `frames` iterator on error events

Rejected for declared and framework error frames because ADR-0009 keeps expected failures as inspectable values; the handle exposes them through `status` and `error`. Client-side misuse (invalid input, missing codec) still rejects.
