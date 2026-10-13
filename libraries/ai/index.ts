/**
 * `@sixthsummit/ship-api/libraries/ai` — LLM helper library public API.
 *
 * Add via `ship-api add -l ai`. Install only the SDK for the providers
 * you use (Anthropic / OpenAI / …) — the library itself takes no SDK
 * runtime dependency; concrete adapters are opt-in.
 */

// Adapters — concrete `LLMProvider` implementations. Install only the
// SDK for the providers you use (see `library.json#optionalNpmDependencies`).
export {
  AnthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicMessagesClient,
} from "./adapters/AnthropicAdapter.js";
// Interface — the load-bearing contract every provider adapter implements.
export type { LLMProvider } from "./adapters/LLMProvider.js";
export {
  OpenAIAdapter,
  type OpenAIAdapterOptions,
  type OpenAIChatClient,
} from "./adapters/OpenAIAdapter.js";

// Tool-calling primitive — pairs a Zod schema with a typed handler;
// produces a `Tool` value the agent loop dispatches against.
export {
  type DefineToolOptions,
  defineTool,
  type Tool,
  type ToolContext,
  type ToolExecuteResult,
  type ToolHandler,
  ToolRegistry,
  toolRegistry,
} from "./tools/defineTool.js";

// Agent loop — moved OFF the stable surface to `./experimental` (AI-R2):
// the hand-rolled model→tool→model loop is the most volatile surface in the
// library (the ecosystem is moving to MCP / provider-native agent runtimes),
// so it carries no stability promise. Import it from
// `@sixthsummit/ship-api/libraries/ai/experimental`. The `defineTool` /
// `toolRegistry` building blocks above stay on the stable barrel — durable.

// Prompt registry — versioned, schema-validated prompt primitive with
// typed `{{name}}` substitution. Pairs with PromptRegistry for id-keyed
// lookup; supports multiple versions per id (eval-suite pinning).
export {
  definePrompt,
  type Prompt,
  type PromptDefinition,
  PromptError,
  PromptRegistry,
  PromptRenderError,
  PromptValidationError,
  promptRegistry,
} from "./prompts/definePrompt.js";
// RAG pipeline — pluggable VectorStore + LLMProvider driver.
// Library takes no dep on libraries/weaviate or any specific store —
// consumers inject their own VectorStore implementation.
export {
  RAG_DEFAULT_PROMPT,
  type RetrieveAndAnswerOptions,
  type RetrieveAndAnswerResult,
  type RetrievedDocument,
  retrieveAndAnswer,
  type VectorStore,
  type VectorStoreSearchOptions,
} from "./rag/retrieveAndAnswer.js";
// Streaming seam — pipes a provider stream through a kernel streaming
// operation's `stream.emit`. The compatibility Hono `streamLLM(c, events)`
// helper remains in `@sixthsummit/ship-api` for route-first apps.
export {
  type LLMFrameStream,
  type LLMStreamFrame,
  type StreamLLMOptions,
  type StreamLLMResult,
  streamLLM,
} from "./streaming/streamLLM.js";
// Structured outputs — single-shot Zod-typed completion via synthetic
// "respond" tool. Provider-portable (any LLMProvider that honors
// tools + toolChoice).
export {
  type CompleteStructuredOptions,
  type CompleteStructuredResult,
  completeStructured,
  StructuredOutputError,
} from "./structured/completeStructured.js";

// Token counting — the pluggable `Tokenizer` interface (durable: a real
// tiktoken/claude tokenizer implements it) + thin pre-call estimate helpers.
// Token *truth* is on `CompleteResult.usage` (AI-R3); `HeuristicTokenizer` /
// `countMessageTokens` are deprecated but kept exported for back-compat.
export {
  type CountMessagesOptions,
  countMessageTokens,
  estimateMessageTokens,
  estimateTokens,
  // Deprecated (AI-R3) — prefer the estimators above for pre-call budgeting
  // and the response `usage` for real counts.
  HeuristicTokenizer,
  type Tokenizer,
} from "./tokens/Tokenizer.js";

// Shared types — message format, completion options, streaming events.
export type {
  CompleteOptions,
  CompleteResult,
  EmbedOptions,
  EmbedResult,
  ImagePart,
  Message,
  MessageContentPart,
  StopReason,
  StreamCompleteOptions,
  StreamEvent,
  StreamStartEvent,
  StreamStopEvent,
  StreamTextDeltaEvent,
  StreamToolInputDeltaEvent,
  StreamToolUseEndEvent,
  StreamToolUseStartEvent,
  TextPart,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
  ToolResultPart,
  ToolUsePart,
} from "./types.js";
