---
'@sixthsummit/ship-angular': minor
---

Add a manifest-typed `createStream()` to the `@sixthsummit/ship-angular/stream` entrypoint
implementing the canonical SSE streaming response mode (SAPI-110).

Given a ShipAPI manifest operation declared `response.mode: "stream"`, the client infers
the frame and terminal types from the contract, builds the request from the declared
method and path, sends `Accept: text/event-stream`, branches on `Content-Type` so a
failure before the first frame surfaces as the normal client error, parses `frame` /
`terminal` / `error` events with `id:` sequence tracking, and ignores `: hb` heartbeat
comments. The handle is signal-first — `frames`, `latest`, `terminal`, `status`
(`idle | connecting | open | closed | error | aborted`), `error` (`{ code, status, message }`),
`seq` — plus `abort()`. A connection that closes without a terminal or error event is
reported as `STREAM_INTERRUPTED`. Locally-reported errors (`STREAM_INTERRUPTED`,
`STREAM_TRANSPORT_FAILED`, `STREAM_PROTOCOL_VIOLATION`) always carry `status: 0`, so a
non-zero status on `error()` always came from the wire. Under server rendering the handle
stays `idle` and no request is opened.

`createOperationStream()`, `parseSseFrames()`, and the root `createStream()` are unchanged.

See the streaming operations guide and ADR 0004 for the full wire contract.
