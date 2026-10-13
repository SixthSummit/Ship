# Streaming

> **Compatibility feature:** this streaming implementation remains available
> from the monolithic v4 package. Streaming is not currently part of the focused
> operation contract or its GA claim.

`streamSSE` for Server-Sent Events and `streamLLM` — the bridge that pipes any `AsyncIterable<{ type, ... }>` from an LLM provider out to a client as SSE. Backpressure handling, client disconnect detection, and how to stream LLM responses end-to-end.

## SSE — `streamSSE`

```ts
import { streamSSE } from "@sixthsummit/ship-api";

app.get("/feed", requireAuth({ provider }), (c) =>
  streamSSE(c, async (stream) => {
    for await (const event of someEventSource()) {
      if (stream.aborted) break;
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
        id: String(event.id),
      });
    }
  }, { spanName: "feed.subscribe" }),
);
```

The wrapper is thin — it sets the right SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`), wraps the callback in an OTel span, and hands you Hono's `SSEStreamingApi`. The interesting properties:

- **`stream.aborted`** flips to `true` when the client disconnects. Check between iterations to bail out cleanly — saves work after the listener is gone.
- **`stream.writeSSE({ event, data, id?, retry? })`** writes one SSE event in the standard format. `id` lets the client resume from a known position via `Last-Event-ID` on reconnect; `retry` tells the client how long to wait before reconnecting after a drop.

### SSE format

```
id: 1
event: message
data: {"type":"message","content":"hello"}

id: 2
event: heartbeat
data: 

```

Each event is `key: value\n` lines, terminated by a blank line. The `data` field is the payload — typically JSON. Multi-line `data` works too (each line prefixed with `data:`); browsers concatenate.

### Heartbeats

The framework doesn't send periodic keep-alive comments automatically. For long-lived streams that go quiet, add an interval that emits `event: heartbeat` (or a comment line `: keepalive\n`) every 15-30 seconds:

```ts
streamSSE(c, async (stream) => {
  const heartbeat = setInterval(() => {
    if (!stream.aborted) stream.writeSSE({ event: "heartbeat", data: "" });
  }, 15_000);

  try {
    for await (const event of someEventSource()) {
      if (stream.aborted) break;
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    }
  } finally {
    clearInterval(heartbeat);
  }
});
```

Most cloud load balancers idle-timeout connections after 60 seconds of silence. Heartbeats keep them alive.

## LLM streaming — `streamLLM`

```ts
import { streamLLM } from "@sixthsummit/ship-api";
import { AnthropicAdapter } from "@sixthsummit/ship-api/libraries/ai";

const llm = new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY });

app.post("/chat", requireAuth({ provider }), validate("json", chatSchema), async (c) => {
  const { messages } = c.req.valid("json");
  const stream = llm.streamComplete({
    model: "claude-opus-4-7",
    messages,
    max_tokens: 4096,
  });
  return streamLLM(c, stream, { spanName: "chat.stream" });
});
```

`streamLLM(c, events, opts?)` takes any `AsyncIterable<{ type: string, ... }>` and pipes each item out as an SSE event. The `type` becomes the SSE `event` field; the remaining fields become the JSON payload.

It's provider-agnostic: the framework's `libraries/ai` exports `StreamEvent` shapes (`start`, `text_delta`, `tool_use_start`, `tool_input_delta`, `tool_use_end`, `stop`), but you can pipe through any iterator with the right shape. Custom event taxonomies work without changing the bridge.

### What `streamLLM` does for you

```ts
function streamLLM(
  c: Context,
  events: AsyncIterable<{ type: string; [key: string]: unknown }>,
  opts?: {
    spanName?: string;                                          // default "llm.stream"
    onError?: (err: Error) => Promise<void> | void;
    generateEventId?: (event: any, index: number) => string;
  },
): Response;
```

- **Wraps in an OTel span** — `spanName` defaults to `llm.stream`. Each token is a span attribute? No, just the overall stream is one span. Use the LLM provider's own instrumentation (or your own `withSpan` calls) for per-message attribution.
- **Calls `iterator.return?.()` on disconnect** — when the client drops, the framework runs the iterator's cleanup. For Anthropic's SDK, that closes the underlying HTTP connection. The provider sees the cancel; the LLM call costs you only the tokens generated before disconnect.
- **Catches and reports errors** — if the iterator throws, calls the optional `onError` hook (swallowed if it throws), writes a final `event: error\ndata: {"message": "..."}` SSE event, then runs the iterator's cleanup. Clients get a structured error event rather than an abrupt connection close.

### Worked example: streaming an LLM with tools

```ts
import { agentLoop, toolRegistry, defineTool } from "@sixthsummit/ship-api/libraries/ai";
import { streamLLM } from "@sixthsummit/ship-api";

const search = defineTool({
  name: "search",
  description: "Search the knowledge base.",
  schema: z.object({ query: z.string() }),
  handler: async ({ query }) => kb.search(query),
});

app.post("/agent/chat", requireAuth({ provider }), async (c) => {
  const { message } = c.req.valid("json");

  // For an agent loop, you typically want events from the loop itself
  // (model_response, tool_call, tool_result) rather than raw provider stream.
  const events = agentLoopAsStream({
    llm,
    tools: toolRegistry(search),
    messages: [{ role: "user", content: message }],
    model: "claude-opus-4-7",
    onEvent: (event) => emit(event),    // a queue/channel pattern
  });

  return streamLLM(c, events, { spanName: "agent.chat" });
});
```

The pattern: instead of streaming the provider's raw stream, stream events from the agent loop. The loop's `onEvent` handler pushes into an async iterable; the route streams the iterable. This gives clients structured events ("the model is thinking", "calling tool X", "got result Y", "model is responding") instead of raw token deltas.

The framework doesn't ship `agentLoopAsStream` — it's a small adapter you write. See [llm-helpers](llm-helpers.md) for the loop's event types.

## Backpressure and disconnect detection

For very fast event sources, the network can become the bottleneck. Three things to know:

- **`stream.aborted` is true after disconnect.** Check between event production iterations. If you don't, you'll keep generating events until the iterator naturally finishes — wasted work.
- **`writeSSE` doesn't await network ack.** It returns when the data is buffered in Node's socket-write queue. For most apps this is fine; for very-high-throughput streams with slow clients, the buffer can grow unbounded. If you observe memory growth, add backpressure logic — pause production until the socket drains.
- **No automatic chunked retries.** If the connection drops mid-stream, the client reconnects (browsers do this automatically with EventSource). The server has no idea what the client received before the drop; the client's `Last-Event-ID` header on reconnect tells you. Use the `id` field on each event so resume works.

## React Native compatibility

Native `EventSource` isn't part of React Native. For SSE, use `react-native-sse`:

```ts
import EventSource from "react-native-sse";

const es = new EventSource(`${BASE_URL}/feed`, {
  headers: { Authorization: `Bearer ${token}` },
});

es.addEventListener("message", (event) => { /* ... */ });
es.addEventListener("error", (event) => { /* ... */ });
```

Recent RN (0.74+) ships an EventSource implementation that mostly works, but `react-native-sse` is more reliable across platforms and has a smaller surface for edge-case bugs. See [cross-framework/react-native-expo](../cross-framework/react-native-expo.md) for more.

## Edge runtime caveat

`streamSSE` and `streamLLM` are built on Hono's standard streaming API, which works on Node and Edge runtimes (Cloudflare Workers, Vercel Edge). No platform-specific code in the framework's streaming layer.

The LLM provider SDKs are the real edge-runtime question. `@anthropic-ai/sdk` and `openai` work in Workers; older SDK versions may not. Test against your actual deployment target before assuming.

## Operational concerns

**SSE is HTTP/1.1, not HTTP/2.** Streaming over HTTP/2 multiplexes onto a single connection — better. But many SSE clients (browsers, curl) negotiate HTTP/1.1 by default. If your load balancer terminates HTTP/2 to the client and HTTP/1.1 to your service, that's fine. If both ends support HTTP/2 end-to-end, prefer it.

**Idle connections cost.** Each open SSE stream is an open HTTP connection. Holding 10,000 connections idle is fine on Node (Node handles connections cheaply); it's a problem if your reverse proxy sets a low `worker_connections` limit. Tune nginx / cloudflare / cloud-load-balancer concurrency for the expected concurrent stream count.

**Don't bypass the framework's middleware on streaming routes.** The same `requireAuth`, `requirePermission`, validation, and rate-limit logic applies — a streaming response doesn't exempt you from authorization. The middleware runs before `streamSSE` returns, so it's all already there if you compose normally.

**Costs are real for LLM streams.** A user opening a streaming chat and walking away costs tokens until the response completes. The framework's disconnect-cleanup gives you the cancellation hook; pair it with a server-side timeout (`AbortSignal.timeout(60_000)`) to bound the worst case.

## Source

- [`packages/core/src/http/streaming/sse.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/streaming/sse.ts) — `streamSSE`
- [`packages/core/src/http/streaming/streamLLM.ts`](https://github.com/sixthsummit/ship-api/blob/main/packages/core/src/http/streaming/streamLLM.ts) — LLM-stream-to-SSE bridge
- Hono's [SSE documentation](https://hono.dev/docs/helpers/streaming) — `streamSSE` is the underlying primitive
- [llm-helpers](llm-helpers.md) — `libraries/ai` for the LLM-side surface streamed through `streamLLM`
