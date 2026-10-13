# eval-005-streaming-chat — render a typed operation stream

You are working in a generated ShipAngular application with packed client artifacts for
stream operation `agent.chat.stream` and its generated binding.

Add a standalone, OnPush `/chat` page. Build the stream with `createOperationStream`, the
generated binding, and the application request policy. Start it explicitly from user input,
render typed text-delta events, and expose Cancel while connecting/open. Render declared
pre-stream failures separately from exceptional protocol/transport errors. Add deterministic
tests for split SSE frames and cancellation.

Do not construct a URL, call raw `fetch`, read a `ReadableStream` directly, or import server
code.

## Success criteria

- Stable operation ID `agent.chat.stream` selects the typed stream contract.
- `events()`, `status()`, `failure()`, `error()`, `start()`, and `cancel()` are used.
- Generated serialization/decoding and shared policy are retained.
- Tests cover split frames and abort behavior.
- `pnpm run ci` passes.
