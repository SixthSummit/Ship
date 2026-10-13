# ADR 0004: Streaming response mode (SSE wire contract)

- **Status:** Accepted jointly with ShipAPI (SAPI-110); client half implemented on the `/stream` entrypoint
- **Date:** 2026-09-18
- **Deciders:** ShipAngular and ShipAPI maintainers
- **Related:** ADR 0002 (structural operation client) and ShipAPI's operation graph

## Context

ADR 0002 keeps streams out of the unary JSON result and gives them their own
capability entrypoint. What it did not fix was the wire: `createOperationStream()`
requires the application to hand-write a binding — URL, success statuses, declared
errors, content types, and a frame decoder — for a stream the contract already
describes. Two applications consuming the same ShipAPI stream could disagree about
event names, about whether a close without a terminal event is success or failure,
and about how a failure that happens before the first byte of the body is reported.

ShipAPI now declares a streaming response mode in the kernel and projects it into
the manifest. Both repositories implement one written contract.

## Decision

`operations[id].response` carries `{ mode: "stream", framing: "sse", frame, terminal?, limits }`.
The frame and terminal schema references participate in the manifest fingerprint, so
a drift between the repositories fails the existing fingerprint gate rather than
surfacing as a decoding bug.

On the wire:

- the request uses the operation's declared method, path, and input, plus `Accept: text/event-stream`;
- each event writes `id`, `event`, then `data` in that order, one `\n`-terminated line each,
  followed by a blank line; `data` is single-line `JSON.stringify` output;
- `id:` is 1-based and increments across frame, terminal, and error events; heartbeats are
  exactly `: hb <unix-ms>`, are written only when nothing was written for `heartbeatMs`, and
  never consume a sequence number;
- unknown event names are ignored, and v1 has no `Last-Event-ID` resumption;
- a failure **before the first frame** is the normal JSON error envelope with its normal
  status; the client branches on `Content-Type` and decodes it with the same parser the
  unary client uses;
- success is `200` with `text/event-stream`, and the body carries `frame`, `terminal`, and
  `error` events with 1-based monotonic `id:` sequence numbers and `: hb <unix-ms>` comments;
- exactly one of `terminal` or `error` ends a stream that started; a close with neither is a
  transport failure the client reports locally as `STREAM_INTERRUPTED`;
- terminal error events use stable codes: `STREAM_MAX_DURATION_EXCEEDED` (504),
  `STREAM_MAX_FRAMES_EXCEEDED` (500), a declared operation error code, or `INTERNAL_ERROR` (500).

On the client, `createStream()` gains a manifest-typed overload. `Frame` and `Terminal` are
inferred from the contract, the request is built from the manifest, and the handle is
signal-first: `frames`, `latest`, `terminal`, `status`, `error`, `seq`, `abort()`. Under
server rendering it returns an `idle` handle and opens no request.

## Consequences

- Applications stop writing a per-stream binding for contract-declared streams. The
  binding-driven `createOperationStream()` stays for streams that need reconnect with
  `Last-Event-ID`, which the v1 wire contract deliberately does not cover.
- The root `createStream()` (URL / `hc()` thunk, `{ events, status, error, abort, reload }`)
  is unchanged; it remains the migration-only compatibility surface.
- Three codes are ShipAngular-local, because the contract names no code for them:
  `STREAM_INTERRUPTED` (defined by the contract, reported locally), `STREAM_TRANSPORT_FAILED`,
  and `STREAM_PROTOCOL_VIOLATION`. All three carry `status: 0`; a non-zero `status` on
  `error()` always came from a wire error event or a JSON error envelope.
- `terminal` is present on every operation ShipAPI emits today, but the client keeps treating
  it as optional so the manifest can drop it without a client release.
- An abort is observable as `status() === 'aborted'` on the handle. `createStream()` returns a
  handle rather than a promise, so no call site has a rejection to catch, including an abort
  before the first frame.
- `maxDurationMs` and `maxFrames` are enforced by the server. The client uses `maxFrames`
  only to bound retained history; it does not run a local duration watchdog, so a server
  that ignores its own limit is observed as an interrupted stream rather than a timeout.

## Evidence

- Browser conformance serves the contract verbatim from `conformance/browser/fixture-server.mjs`
  and asserts observed frames, terminal payload, `seq`, the `connecting → open → closed`
  transitions, error-after-frame, error-before-frame, and abort (including the server
  observing the close).
- Packed conformance adds a `mode: "stream"` operation to the synthetic ShipAPI contract and
  proves the packed client renders an `idle` handle and opens no request in a server runtime.
- Unit specs cover parser framing (CRLF, comments, multi-line data, chunk boundaries, sticky
  ids) and every `createStream` status transition, error branch, and abort path.

## Alternatives rejected

- **Reusing `createOperationStream()`'s binding for contract streams.** It keeps the
  application as the source of truth for the URL and decoder, which is exactly the skew this
  ADR removes.
- **A body-level error frame for pre-first-frame failures.** It would force every client to
  open a stream to learn it was unauthorized, and would give the same failure two shapes
  depending on timing.
- **Client-side duration enforcement.** Two timers for one limit produce two answers; the
  server owns the budget it declared.
