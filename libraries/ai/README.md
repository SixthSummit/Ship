# `libraries/ai/` — LLM helper library

The framework's defining differentiator. Provider-agnostic LLM tooling that consumers compose into their app: provider adapters (Anthropic + OpenAI today), prompt registry, tool-calling, agent loop, structured outputs, RAG, token counting.

> **Install via**: `ship-api add -l ai`. The library itself takes **no** SDK runtime dependency — concrete provider adapters are opt-in (install only the SDK for the providers you use).

## What's inside

```
libraries/ai/
├── adapters/
│   ├── LLMProvider.ts           — pluggable provider contract
│   ├── AnthropicAdapter.ts      — wraps @anthropic-ai/sdk
│   └── OpenAIAdapter.ts         — wraps openai
├── tools/
│   └── defineTool.ts            — Zod schema → typed handler + ToolRegistry
├── loop/
│   └── agentLoop.ts             — model→tool→model cycle with retry budget + signal honoring
├── structured/
│   └── completeStructured.ts    — Zod-typed single-shot via synthetic-tool pattern
├── prompts/
│   └── definePrompt.ts          — versioned prompt primitive + PromptRegistry
├── rag/
│   └── retrieveAndAnswer.ts     — pluggable VectorStore + LLMProvider RAG driver
├── tokens/
│   └── Tokenizer.ts             — pluggable tokenizer + HeuristicTokenizer baseline
├── types.ts                     — cross-provider lingua franca
└── index.ts                     — public barrel
```

## Quick reference

### Provider-portable completion

```ts
import { AnthropicAdapter } from "@sixthsummit/ship-api/libraries/ai";

const llm = new AnthropicAdapter({ apiKey: env.ANTHROPIC_API_KEY });

const result = await llm.complete({
  model: "claude-opus-4-7",
  system: "Be concise.",
  messages: [{ role: "user", content: "What is 2+2?" }],
});
console.log(result.text); // "4"
```

Swap `AnthropicAdapter` for `OpenAIAdapter` and the same call site works — provider-specific tunables ride on `providerOptions` so the cross-provider surface stays narrow.

### Tool calling

```ts
import { defineTool, toolRegistry } from "@sixthsummit/ship-api/libraries/ai";
// agentLoop is experimental (AI-R2) — no stability promise; the hand-rolled
// loop is expected to be superseded by MCP / provider-native agent runtimes.
import { agentLoop } from "@sixthsummit/ship-api/libraries/ai/experimental";
import { z } from "zod";

const getWeather = defineTool({
  name: "get_weather",
  description: "Look up current weather for a city",
  schema: z.object({ city: z.string() }),
  handler: async ({ city }) => fetchWeather(city),
});

const result = await agentLoop({
  llm,
  tools: toolRegistry(getWeather),
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "What's the weather in Paris?" }],
  maxIterations: 5,
});
console.log(result.finalText);
```

### Structured outputs

```ts
import { completeStructured } from "@sixthsummit/ship-api/libraries/ai";
import { z } from "zod";

const { data } = await completeStructured({
  llm,
  schema: z.object({
    sentiment: z.enum(["positive", "neutral", "negative"]),
    confidence: z.number().min(0).max(1),
  }),
  model: "claude-opus-4-7",
  messages: [{ role: "user", content: "I love this product!" }],
});
// data: { sentiment: "positive", confidence: 0.95 }
```

### RAG

```ts
import { retrieveAndAnswer } from "@sixthsummit/ship-api/libraries/ai";

// Bring your own VectorStore — interface-only; no library coupling.
const store: VectorStore = {
  name: "weaviate",
  async search({ query, topK }) {
    /* ... */
  },
};

const { answer, sources } = await retrieveAndAnswer({
  llm,
  vectorStore: store,
  query: "What is the capital of France?",
  topK: 5,
  model: "claude-opus-4-7",
});
```

### Streaming

```ts
import { streamLLM } from "@sixthsummit/ship-api";

app.post("/chat", validate("json", schema), async (c) => {
  const { prompt } = c.req.valid("json");
  const stream = llm.streamComplete({
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: prompt }],
  });
  return streamLLM(c, stream); // → SSE; client disconnect cancels upstream
});
```

### Versioned prompts

```ts
import { definePrompt, PromptRegistry } from "@sixthsummit/ship-api/libraries/ai";

const greetPrompt = definePrompt({
  id: "greetings.welcome",
  version: 3,
  template: "Hello, {{name}}! Welcome to {{appName}}.",
  schema: z.object({ name: z.string(), appName: z.string() }),
});

greetPrompt.render({ name: "Ada", appName: "ShipAPI" });
// "Hello, Ada! Welcome to ShipAPI."
```

CI lint flags un-versioned changes — bumping `version` on every meaningful change makes the change auditable and lets eval suites pin to a known-good version.

## Conventions

- **The library never imports a provider SDK directly.** Adapters import the SDK they wrap; consumers install only the SDK for the providers they use.
- **Provider-specific tunables ride in `providerOptions` / `providerExtras`** so the cross-provider surface stays narrow.
- **Tools must be idempotent.** The agent loop's at-least-once delivery semantics mean a handler may be re-invoked after a crash or retry. Use `dedupeKey` for downstream deduplication where supported.
- **Streaming abort honored end-to-end.** Client disconnect propagates through `streamLLM` → `iterator.return()` → upstream provider stream cancellation.

## Versioning

This library is **versioned independently of the framework core** (AI-A3): the AI substrate moves fastest, so it bumps on its own schedule via `library.json#version` without dragging the stable `4.x` framework version. On `ship-api add -l ai` the vendored version is stamped into `src/lib/ai/.ship-lib.json`, so staleness is detectable and `ship-api update` has an anchor to diff against. **Bump `library.json#version` on any meaningful change** — pre-1.0, breaking changes bump the minor, additive/fix changes bump the patch. See [`CHANGELOG.md`](./CHANGELOG.md).

## See also

- [Plan §G](#) (LLM helpers section in the master plan)
- [v4 status](../../docs/V4_STATUS.md)
- [AGENTS.md](../../AGENTS.md)
