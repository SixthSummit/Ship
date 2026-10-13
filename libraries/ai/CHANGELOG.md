# `ai` library — changelog

The `ai` library is **versioned independently of the framework core** (AI-A3 / A2-11): the AI substrate churns fastest, so it bumps on its own schedule without dragging the stable framework version. The current version lives in `library.json#version` and is stamped into a consumer's `src/lib/ai/.ship-lib.json` on `ship-api add -l ai` (so staleness is detectable and `ship-api update` has an anchor).

**Versioning rule:** bump `library.json#version` on any meaningful change to the `ai` surface. Pre-1.0, breaking changes bump the **minor**; additive/fix changes bump the **patch**. This is decoupled from the framework's `4.x` line.

## 0.2.0

Part II AI-library refinement (alpha-window, deliberate).

- **AI-R1** — the `LLMProvider` seam is now genuinely pass-through, not lowest-common-denominator: `CompleteResult` / `StreamStopEvent` carry `raw` + `providerExtras`, `TokenUsage` carries `reasoningTokens` + `raw`, both adapters populate them (Anthropic thinking/citations/server-tool-use; OpenAI refusal/reasoning tokens), and `agentLoop` / `retrieveAndAnswer` no longer drop `providerOptions` / `metadata`. Additive-optional.
- **AI-R2** (breaking) — `agentLoop` moved off the stable barrel to `@sixthsummit/ship-api/libraries/ai/experimental`; it carries no stability promise and is expected to be superseded by MCP / provider-native agent runtimes. `defineTool` / `toolRegistry` stay on the stable barrel.
- **AI-R3** — `HeuristicTokenizer` / `countMessageTokens` deprecated (token truth is the provider response `usage`); added thin `estimateTokens` / `estimateMessageTokens` for pre-call prompt-fit / rate-limit budgeting. The `Tokenizer` interface is unchanged.

## 0.1.0

Initial `ai` library: the `LLMProvider` interface + Anthropic & OpenAI adapters, `defineTool` / `toolRegistry`, `agentLoop`, `completeStructured`, the `definePrompt` prompt registry, the `retrieveAndAnswer` RAG pipeline, and a pluggable `Tokenizer`.
