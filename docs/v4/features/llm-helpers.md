# LLM helpers

> **Compatibility library:** these helpers remain available to current v4
> consumers. They are not a defining kernel primitive; operation applications
> should expose an LLM provider as an explicit capability when they need one.

`libraries/ai` — the framework's LLM toolkit. The `LLMProvider` interface, Anthropic and OpenAI adapters, the agent loop with tool use, structured outputs via Zod schemas, versioned prompts, RAG, and pluggable token counting. The framework's defining differentiator.

## What's in the library

```
libraries/ai/
├── adapters/
│   ├── LLMProvider.ts            # the interface
│   ├── AnthropicAdapter.ts
│   └── OpenAIAdapter.ts
├── tools/
│   └── defineTool.ts             # Zod-typed tool definitions + ToolRegistry
├── loop/
│   └── agentLoop.ts              # model → tool → model with retry budget + lifecycle events
├── structured/
│   └── completeStructured.ts     # Zod schema → typed output via synthetic-tool pattern
├── prompts/
│   └── definePrompt.ts           # versioned prompts with input validation
├── rag/
│   └── retrieveAndAnswer.ts      # RAG with pluggable VectorStore
└── tokens/
    └── Tokenizer.ts              # pluggable interface + HeuristicTokenizer
```

The library is a peer of `packages/core` — published independently, but co-versioned. Import from `@sixthsummit/ship-api/libraries/ai` (or whatever subpath the consumer prefers; the surfaces are stable).

## The provider interface

```ts
interface LLMProvider {
  readonly name: string;                                            // "anthropic", "openai", etc.
  complete(opts: CompleteOptions): Promise<CompleteResult>;         // single-turn
  streamComplete(opts: StreamCompleteOptions): AsyncIterable<StreamEvent>;
  embed?(opts: EmbedOptions): Promise<EmbedResult>;                 // optional
}
```

The interface is small and provider-agnostic. The library ships two adapters; consumers can write more. Application code targets `LLMProvider`, not `AnthropicAdapter` directly — swapping providers is a one-line composition-root change.

### AnthropicAdapter

```ts
import { AnthropicAdapter } from "@sixthsummit/ship-api/libraries/ai";

const llm = new AnthropicAdapter({
  apiKey: env.ANTHROPIC_API_KEY,
  defaultMaxTokens: 4096,
});

const result = await llm.complete({
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "Hello" }],
});
// result.content: ContentBlock[], result.stopReason, result.usage
```

The adapter wraps `@anthropic-ai/sdk`. Constructor options:

| Option | Type | Notes |
| --- | --- | --- |
| `apiKey` | `string` | Required unless `client` is supplied. |
| `baseURL` | `string` | Override default (useful for proxies, gateways). |
| `defaultHeaders` | `Record<string, string>` | Forwarded to every request. |
| `client` | `AnthropicMessagesClient` | Pre-built or stubbed client (tests). |
| `defaultMaxTokens` | `number` | Used when `maxTokens` isn't passed; default 4096. |

The adapter normalizes Anthropic's response into `CompleteResult` — same shape every other adapter produces. Streaming events similarly translate Anthropic's raw event types into the cross-provider `StreamEvent` shape.

### OpenAIAdapter

Same constructor pattern, wraps `openai`. The library proves the interface generalizes — swapping between Anthropic and OpenAI is `new OpenAIAdapter(opts)` instead of `new AnthropicAdapter(opts)`.

### Writing a custom adapter

Implement `LLMProvider`. The framework provides type tests against the interface in CI; if a method's shape drifts, builds fail. Common patterns for custom adapters:

- **Local model (Ollama, vLLM)** — wrap the local API; same `complete` / `streamComplete` shape.
- **Provider gateway (LiteLLM, Helicone)** — wrap the gateway's API; gain observability + rate-limit at the gateway layer.
- **Mock adapter (for tests)** — return canned responses based on a queue. The library uses this pattern internally for agent-loop tests.

## Tools

Tools let the model call functions in your application. Define one with a Zod schema for the inputs:

```ts
import { defineTool } from "@sixthsummit/ship-api/libraries/ai";
import { z } from "zod";

const getWeather = defineTool({
  name: "get_weather",
  description: "Look up the current weather for a single city.",
  schema: z.object({
    city: z.string().describe("City name, e.g. 'San Francisco'"),
  }),
  handler: async ({ city }, ctx) => {
    const weather = await weatherApi.fetch(city);
    return { city, tempC: weather.tempC, condition: weather.condition };
  },
});
```

The `defineTool` call returns a `Tool` with:

- `definition` — the JSON Schema view of the input schema, in the format LLM providers expect.
- `execute(input, ctx)` — runs the handler with parsed-and-validated input. Returns `{ ok: true, output }` on success, `{ ok: false, isError: true, content }` on validation failure or handler throw.

Two patterns to know:

**Schema descriptions matter.** The model reads them when deciding whether and how to call the tool. `z.string().describe("City name, e.g. 'San Francisco'")` produces useful behavior; an undescribed `z.string()` works but is less reliable.

**Handler errors are recoverable, not fatal.** When a tool handler throws, the library catches it and returns an error result the model sees. The model can recover (try a different tool, ask the user, abandon the goal). Don't throw `AppError` from tool handlers — return early with a structured failure if needed:

```ts
handler: async ({ city }, ctx) => {
  const weather = await weatherApi.fetch(city);
  if (!weather) return { error: "No weather data for that city; try a major city name" };
  return { city, tempC: weather.tempC, condition: weather.condition };
},
```

### ToolRegistry

```ts
import { toolRegistry } from "@sixthsummit/ship-api/libraries/ai";

const tools = toolRegistry(getWeather, search, sendMessage);
// tools.has("get_weather") → true
// tools.lookup("get_weather") → Tool
// tools.getDefinitions() → ToolDefinition[]   (for passing to the LLM)
```

The registry is an ordered collection. Duplicate names throw at registration time — a fast way to surface accidental redefinitions.

## The agent loop

```ts
import { agentLoop } from "@sixthsummit/ship-api/libraries/ai";

const result = await agentLoop({
  llm,
  tools,
  messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  model: "claude-opus-4-7",
  maxIterations: 10,
  signal: AbortSignal.timeout(30_000),
  onEvent: (event) => {
    switch (event.type) {
      case "iteration_start": console.log(`iter ${event.iteration}`); break;
      case "tool_call": console.log(`calling ${event.name} with`, event.input); break;
      case "tool_result": console.log(`result:`, event.ok ? event.output : event.error); break;
      case "complete": console.log(`done in ${event.iterations} iterations`); break;
    }
  },
});

console.log(result.finalText);
console.log("Total tokens:", result.totalUsage);
console.log("Iterations:", result.iterations);
```

What it does, per iteration:

1. Calls `llm.complete()` with the running history and the registry's tool definitions.
2. If the response has `tool_use` content blocks, executes each via the registry. Appends a `user` message with `tool_result` blocks.
3. If the response has no tool calls (`stopReason !== "tool_use"`), the loop terminates.
4. If `maxIterations` is hit before termination, throws `AgentLoopMaxIterationsError` with the partial history (debug, recover gracefully).

The `onEvent` hook is the observability point. Hook into it for:

- **Streaming progress to the client** — push events into a queue, stream the queue out via [streamLLM](streaming.md).
- **Per-step OTel spans** — call `withSpan` per tool invocation.
- **Cost tracking** — sum `event.result.usage` per iteration, emit a metric.
- **Audit logging** — record every tool call and result for compliance.

### Why the loop is in the library

The LLM provider's API gives you one round-trip: send messages, get a response. If the response is a tool call, the *application* has to dispatch the tool, append the result, and call again. Every app implementing this hand-rolls the same code with subtle bugs (retry-budget overflow, signal-handling, error formatting).

The library's loop is the canonical implementation. Tested, abort-safe, with structured events. If you find yourself writing your own version of it, you've probably hit a case the library doesn't handle — file an issue.

## Structured outputs

When you want the model to produce a specific JSON shape:

```ts
import { completeStructured } from "@sixthsummit/ship-api/libraries/ai";
import { z } from "zod";

const ReviewSchema = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  topics: z.array(z.string()).max(5),
  summary: z.string().max(200),
});

const result = await completeStructured({
  llm,
  schema: ReviewSchema,
  model: "claude-opus-4-7",
  messages: [
    { role: "user", content: `Analyze this review: "${reviewText}"` },
  ],
});

// result.data: { sentiment, topics, summary }   — typed via z.infer<typeof ReviewSchema>
// result.raw:  the raw provider response
```

Under the hood, the library:

1. Translates the Zod schema to JSON Schema.
2. Wraps it as a synthetic tool named `respond` (or whatever `responseToolName` you set).
3. Forces the provider to invoke the tool via `tool_choice: { type: "tool", name: "respond" }`.
4. Parses the tool's input through the original Zod schema. Throws `StructuredOutputError` on validation failure.

Why the synthetic-tool pattern instead of "ask the model to return JSON in text":

- **Tool inputs are the model's native structured-output channel.** The provider can constrain decoding to the schema; you don't have to parse-and-pray.
- **Provider-portable.** Any `LLMProvider` whose `complete()` honors tools + tool_choice supports this pattern. No provider-specific JSON mode plumbing.
- **Errors surface correctly.** Schema mismatches are explicit (validation throws); freeform JSON parsing is a long tail of edge cases.

## Versioned prompts

```ts
import { definePrompt } from "@sixthsummit/ship-api/libraries/ai";

const SystemPrompt = definePrompt({
  id: "support_agent",
  version: 3,
  description: "Tone and persona for the support agent.",
  template: `You are a {{tier}} support agent for {{product}}. Be concise, accurate, and empathetic. {{extraInstructions}}`,
  schema: z.object({
    tier: z.enum(["frontline", "specialist"]),
    product: z.string(),
    extraInstructions: z.string().default(""),
  }),
});

const rendered = SystemPrompt.render({ tier: "frontline", product: "ShipAPI" });
```

What this gets you:

- **Versioned.** The version number in the definition is the contract — bump it on every meaningful change. Convention: every `definePrompt` change must bump the version in the same hunk. Eval suites and observability pipelines pin to known-good versions; without versioning, you can't tell whether a regression is the prompt's fault or something downstream.
- **Input validation.** The Zod schema runs before substitution. A typo in the input field name throws at render time, not at LLM-response time.
- **Mustache substitution.** `{{name}}` placeholders, whitespace-tolerant (`{{ name }}` works too). Escape with `\{{` for literals. Missing placeholders throw.

### Prompt registry

```ts
import { promptRegistry } from "@sixthsummit/ship-api/libraries/ai";

promptRegistry.register(SystemPrompt);
const prompt = promptRegistry.lookup("support_agent", 3);
```

Useful when prompts are looked up by id (e.g., from a database). Most apps just import the prompt directly; the registry exists for cases where prompt selection is dynamic.

## RAG — retrieve and answer

```ts
import { retrieveAndAnswer } from "@sixthsummit/ship-api/libraries/ai";

const result = await retrieveAndAnswer({
  llm,
  vectorStore,                                    // your VectorStore implementation
  query: "How do I configure rate limits?",
  topK: 5,
  model: "claude-opus-4-7",
});

console.log(result.answer);
console.log("Sources:");
for (const doc of result.sources) {
  console.log(`[${doc.id}] ${doc.metadata?.url}`);
}
```

The pipeline:

1. Calls `vectorStore.search({ query, topK })`. Returns top-k similar documents.
2. Formats them as a numbered context block.
3. Sends the prompt + documents to the LLM.
4. Returns the answer and the documents (so you can render citations).

### VectorStore interface

```ts
interface VectorStore {
  readonly name: string;
  search(opts: VectorStoreSearchOptions): Promise<RetrievedDocument[]>;
}

interface VectorStoreSearchOptions {
  query: string;
  topK: number;
  filter?: Record<string, unknown>;        // store-specific (tenant scoping, namespace)
  signal?: AbortSignal;
}

interface RetrievedDocument {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;      // source URL, author, timestamp, etc.
}
```

The library doesn't ship a default vector store — it's pluggable. Typical implementations:

- **Weaviate** — `libraries/weaviate` ships an adapter.
- **Postgres + pgvector** — write a small adapter that runs the cosine-similarity query.
- **Pinecone, Qdrant, Milvus** — wrap each vendor's SDK.
- **In-memory** — for tests; a small `Map<id, embedding>` plus a cosine-similarity scan.

The point of the abstraction is composability: swap stores during development without rewriting the RAG pipeline.

### Default prompt

The library exports `RAG_DEFAULT_PROMPT` — a versioned prompt that asks the model to answer using only the provided documents and to cite them. Override via the `promptTemplate` option:

```ts
const customPrompt = definePrompt({
  id: "rag_custom",
  version: 1,
  template: "Answer this question using only the docs below. Be cautious; say 'I don't know' if unsure.\n\nQuestion: {{query}}\n\nDocs:\n{{documents}}",
  schema: z.object({ query: z.string(), documents: z.string() }),
});

await retrieveAndAnswer({ llm, vectorStore, query, model, promptTemplate: customPrompt });
```

## Token counting

```ts
import { HeuristicTokenizer, countMessageTokens } from "@sixthsummit/ship-api/libraries/ai";

const tokenizer = new HeuristicTokenizer({ charsPerToken: 4 });

const tokens = countMessageTokens(tokenizer, messages, { perMessageOverhead: 4 });
// approximate token count, ±15% accuracy
```

`HeuristicTokenizer` is the rule-of-thumb estimator (~4 chars per token in English). Good for:

- **Rate-limit budgeting.** Estimate before calling, decide whether to truncate.
- **Prompt-fit gating.** Reject inputs that would exceed the model's context window.
- **Approximate cost estimation.** Multiply tokens by per-token price.

Bad for:

- **Exact billing.** Use the provider's actual usage from `result.usage`.
- **Exact budgeting on edge cases.** Heuristic is off by ±15%; for tight budgets use a real tokenizer.

### Plugging in a real tokenizer

```ts
import { Tokenizer } from "@sixthsummit/ship-api/libraries/ai";
import { encoding_for_model } from "tiktoken";   // OpenAI's tokenizer

class TiktokenTokenizer implements Tokenizer {
  readonly model: string;
  private encoder: Tiktoken;

  constructor(model: "gpt-4o" | "gpt-4o-mini") {
    this.model = model;
    this.encoder = encoding_for_model(model);
  }

  count(text: string): number {
    return this.encoder.encode(text).length;
  }

  dispose() {
    this.encoder.free();
  }
}
```

Real tokenizers are accurate but heavier — `tiktoken` ships a 5+ MB WASM blob, not great for edge runtimes. The interface is pluggable so each environment picks the right tokenizer (heuristic in Workers, tiktoken on Node).

## A worked end-to-end example

```ts
import {
  definePrompt, defineTool, toolRegistry, agentLoop,
  AnthropicAdapter,
} from "@sixthsummit/ship-api/libraries/ai";
import { streamLLM } from "@sixthsummit/ship-api";
import { z } from "zod";

const llm = new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY });

const SystemPrompt = definePrompt({
  id: "incident_responder",
  version: 1,
  template: "You are an incident-response engineer. Use the tools to investigate. Be concise.",
});

const queryLogs = defineTool({
  name: "query_logs",
  description: "Search structured logs by query string and time range.",
  schema: z.object({
    query: z.string(),
    fromIso: z.string(),
    toIso: z.string(),
  }),
  handler: async ({ query, fromIso, toIso }) => {
    return await logsService.search({ query, from: fromIso, to: toIso, limit: 50 });
  },
});

const queryMetrics = defineTool({
  name: "query_metrics",
  description: "Query a Prometheus-style metric over a time range.",
  schema: z.object({
    metric: z.string(),
    fromIso: z.string(),
    toIso: z.string(),
    step: z.string().default("60s"),
  }),
  handler: async ({ metric, fromIso, toIso, step }) => {
    return await metricsService.queryRange({ metric, from: fromIso, to: toIso, step });
  },
});

app.post(
  "/agents/incident-response",
  requireAuth({ provider }),
  requirePermission("incidents:respond"),
  validate("json", z.object({ description: z.string() })),
  async (c) => {
    const { description } = c.req.valid("json");

    const events: AgentEvent[] = [];
    const result = await agentLoop({
      llm,
      tools: toolRegistry(queryLogs, queryMetrics),
      messages: [
        { role: "system", content: SystemPrompt.render({}) },
        { role: "user", content: `Investigate: ${description}` },
      ],
      model: "claude-opus-4-7",
      maxIterations: 8,
      signal: AbortSignal.timeout(60_000),
      onEvent: (event) => { events.push(event); },
    });

    return c.json({
      summary: result.finalText,
      iterations: result.iterations,
      tokenUsage: result.totalUsage,
      events,
    });
  },
);
```

This is a complete agent-driven endpoint: prompt + tools + agent loop + auth + validation + framework error handling. The agent investigates incidents by querying logs and metrics; the response includes the summary, the work the agent did, and the cost.

For the streaming variant, push events into an `AsyncIterable` and pipe through `streamLLM`. See [streaming](streaming.md).

## Testing

The library's tests use a `queueLLM` mock adapter that implements `LLMProvider` and returns canned responses from a queue. The pattern works for application tests too:

```ts
function queueLLM(responses: CompleteResult[]): LLMProvider {
  const queue = [...responses];
  return {
    name: "queue",
    complete: async () => {
      const next = queue.shift();
      if (!next) throw new Error("queueLLM: no more responses queued");
      return next;
    },
    async *streamComplete() { /* not used in non-stream tests */ },
  };
}

const mockLLM = queueLLM([
  { content: [{ type: "tool_use", name: "query_logs", input: {...}, id: "tu_1" }], stopReason: "tool_use", usage: {...} },
  { content: [{ type: "text", text: "Found a spike at 14:42." }], stopReason: "end_turn", usage: {...} },
]);

const result = await agentLoop({
  llm: mockLLM,
  tools: toolRegistry(queryLogs),
  messages: [{ role: "user", content: "Investigate" }],
  model: "queue-test",
});

expect(result.finalText).toContain("spike at 14:42");
```

The library's loop tests are the canonical reference for this pattern. Mirror them in your application tests when agent behavior matters to your test contract.

## Operational concerns

**LLM calls are slow.** A typical complete-with-tools call takes 1–10 seconds. For interactive use cases, stream. For background work, queue (BullMQ jobs are the right shape).

**Costs add up.** Each call consumes tokens; agent loops can chain many calls. Track `result.usage` (or sum across iterations from the loop result) and emit a metric. Set `maxIterations` to bound runaway loops.

**Provider downtime exists.** Anthropic and OpenAI both have outages. Handle 5xx responses with retries (with exponential backoff and a circuit breaker for sustained failures); for critical paths, consider failover to a second provider via your `LLMProvider` abstraction.

**Don't trust LLM output.** Even with structured outputs, validate. The model can produce a JSON object that satisfies the schema but contains nonsense values. Application logic should sanity-check (e.g., a date in the future is suspicious for "incident timestamp").

**Tools run with your service's permissions.** A tool that calls `db.execute(<arbitrary SQL>)` is letting the model run arbitrary SQL. Limit each tool's authority to the minimum it needs; treat tool handlers like external API endpoints — auth, validation, scoping all apply.

**Eval before shipping.** A change to a prompt or model can degrade behavior in ways that don't show up until production. Maintain an eval suite (small set of inputs with known-good outputs) and run it on every prompt or model change. The framework doesn't ship an eval framework — many good ones exist; pick one that fits your shape.

## Source

- [`libraries/ai/adapters/`](https://github.com/sixthsummit/ship-api/tree/main/libraries/ai/adapters) — `LLMProvider`, `AnthropicAdapter`, `OpenAIAdapter`
- [`libraries/ai/tools/defineTool.ts`](https://github.com/sixthsummit/ship-api/blob/main/libraries/ai/tools/defineTool.ts) — `defineTool`, `ToolRegistry`
- [`libraries/ai/loop/agentLoop.ts`](https://github.com/sixthsummit/ship-api/blob/main/libraries/ai/loop/agentLoop.ts) — the loop, lifecycle events
- [`libraries/ai/structured/completeStructured.ts`](https://github.com/sixthsummit/ship-api/blob/main/libraries/ai/structured/completeStructured.ts) — Zod schema → typed output
- [`libraries/ai/prompts/definePrompt.ts`](https://github.com/sixthsummit/ship-api/blob/main/libraries/ai/prompts/definePrompt.ts) — versioned prompts
- [`libraries/ai/rag/retrieveAndAnswer.ts`](https://github.com/sixthsummit/ship-api/blob/main/libraries/ai/rag/retrieveAndAnswer.ts) — RAG pipeline
- [`libraries/ai/tokens/Tokenizer.ts`](https://github.com/sixthsummit/ship-api/blob/main/libraries/ai/tokens/Tokenizer.ts) — `Tokenizer` interface, `HeuristicTokenizer`, `countMessageTokens`
- [streaming](streaming.md) — `streamLLM` for piping the streaming variant of any of these flows out to clients
