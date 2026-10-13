/**
 * Shared types for the LLM helper library — the lingua franca every
 * `LLMProvider` adapter (Anthropic, OpenAI, future Bedrock / Vertex /
 * local-Ollama) translates to and from. Adapters own provider-specific
 * SDK shapes; the framework never sees them.
 *
 * Designed for the v4 plan §G surface: `complete`, `streamComplete`,
 * structured outputs (Zod schema → typed `T`), tool calling, agent
 * loop, embeddings, token counting, streaming through Hono `streamSSE`.
 *
 * Type-only — no runtime imports.
 */

/**
 * One conversational turn. The role identifies the speaker; content is
 * either a single text string (the common case) or an ordered array of
 * `MessageContentPart`s (mixed text + tool-use + tool-result + image
 * parts, used for tool-calling and multi-modal flows).
 *
 * `system` messages are *not* in the array — providers handle them as a
 * top-level option (`opts.system`) per their respective API conventions.
 * Mixing them in here would force every adapter to scan the array and
 * extract them, which is ceremony.
 */
export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | MessageContentPart[];
  /** Optional name for tool-result messages (echoes the tool name). */
  name?: string;
}

export type MessageContentPart = TextPart | ToolUsePart | ToolResultPart | ImagePart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolUsePart {
  type: "tool_use";
  /** Adapter-issued tool-call ID; passed back in the matching `ToolResultPart`. */
  id: string;
  name: string;
  /** Parsed JSON object. Adapters parse the provider's raw string for us. */
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  /** ID of the originating `ToolUsePart`. */
  toolUseId: string;
  /** Stringified result; adapters serialize objects via JSON.stringify. */
  content: string;
  /** True if the tool handler threw — providers handle errors differently. */
  isError?: boolean;
}

export interface ImagePart {
  type: "image";
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

/**
 * Top-level options to a single non-streaming completion request.
 * Provider-specific tunables (e.g., Anthropic `top_k`, OpenAI
 * `frequency_penalty`) ride along in `providerOptions` so they don't
 * pollute the cross-provider surface.
 */
export interface CompleteOptions {
  model: string;
  messages: Message[];
  /** Top-level system prompt. Providers pass it as their dedicated field. */
  system?: string;
  /** Caller-defined ceiling. Adapters apply provider-specific defaults if omitted. */
  maxTokens?: number;
  /** 0–1; adapters clamp / translate to provider scales. */
  temperature?: number;
  /** Tool definitions the model may invoke. */
  tools?: ToolDefinition[];
  /**
   * Force a specific tool, allow any tool, or disable tool use entirely.
   * Mirrors Anthropic / OpenAI "tool_choice" semantics.
   */
  toolChoice?: ToolChoice;
  /** Stop sequences. */
  stopSequences?: string[];
  /** AbortSignal — adapters wire to the SDK's abort path. */
  signal?: AbortSignal;
  /**
   * Pass-through for provider-specific options the unified surface
   * doesn't yet model. Adapters merge into the provider request.
   */
  providerOptions?: Record<string, unknown>;
  /** Request-tagging for observability / cost-tracking integrations. */
  metadata?: Record<string, string>;
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "none" }
  | { type: "tool"; name: string };

/**
 * Structural tool definition. The library's `defineTool({...})` factory
 * (later commit) produces these from a Zod schema + handler; adapters
 * forward the JSON Schema as-is.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (Draft 7+) describing the tool's input. */
  inputSchema: Record<string, unknown>;
}

/**
 * Result of a non-streaming completion. The `content` array preserves
 * every part the model emitted (text + tool-use + …) in order; callers
 * filter for what they need. `text` is a convenience join of all text
 * parts.
 */
export interface CompleteResult {
  /** Provider's stable identifier for this response (e.g. for retries). */
  id: string;
  model: string;
  content: MessageContentPart[];
  /** Convenience: concatenated text parts. */
  text: string;
  /** Why the model stopped — normalized across providers. */
  stopReason: StopReason;
  /** Stop sequence that triggered, when stopReason === "stop_sequence". */
  stopSequence?: string;
  usage: TokenUsage;
  /** Pass-through for provider-specific extras (e.g. caching metadata). */
  providerExtras?: Record<string, unknown>;
  /**
   * The untranslated provider SDK response — escape hatch for native
   * fields the unified surface drops (thinking blocks, citations,
   * server-tool use, …). Shape is provider-specific; cast at the use site.
   */
  raw?: unknown;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "content_filter"
  | "unknown";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-supported cache reads (Anthropic prompt caching). */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Reasoning/thinking tokens billed as output (OpenAI o-series
   * `completion_tokens_details.reasoning_tokens`; Anthropic extended
   * thinking). Present only when the provider reports it.
   */
  reasoningTokens?: number;
  /** The untranslated provider usage object — escape hatch for fields not modeled here. */
  raw?: unknown;
}

/**
 * Streaming events. Adapters translate each provider's stream protocol
 * (Anthropic SSE event-types, OpenAI delta chunks) into this set.
 *
 * Event order on a successful turn:
 *   1. one `start` (model id + initial usage if available)
 *   2. zero-or-more `text_delta` (incremental content tokens)
 *   3. zero-or-more `tool_use_start` + `tool_input_delta` + `tool_use_end`
 *      groups (one per tool call the model emits)
 *   4. one `stop` (stopReason + final usage)
 *
 * Errors throw out of the iterator — no `error` event variant; callers
 * use try/catch or `for await` rejection.
 */
export type StreamEvent =
  | StreamStartEvent
  | StreamTextDeltaEvent
  | StreamToolUseStartEvent
  | StreamToolInputDeltaEvent
  | StreamToolUseEndEvent
  | StreamStopEvent;

export interface StreamStartEvent {
  type: "start";
  id: string;
  model: string;
}

export interface StreamTextDeltaEvent {
  type: "text_delta";
  /** The new token(s) to append. */
  delta: string;
}

export interface StreamToolUseStartEvent {
  type: "tool_use_start";
  /** Adapter-issued ID for matching `tool_input_delta` / `tool_use_end`. */
  id: string;
  name: string;
}

export interface StreamToolInputDeltaEvent {
  type: "tool_input_delta";
  id: string;
  /** Partial JSON string; concatenate to reconstruct the full input. */
  partialJson: string;
}

export interface StreamToolUseEndEvent {
  type: "tool_use_end";
  id: string;
  /** Parsed input — adapter does the JSON.parse once the tool_use closes. */
  input: Record<string, unknown>;
}

export interface StreamStopEvent {
  type: "stop";
  stopReason: StopReason;
  stopSequence?: string;
  usage: TokenUsage;
  /** Pass-through for provider-specific extras on the final event (parity with `CompleteResult`). */
  providerExtras?: Record<string, unknown>;
  /** The untranslated final provider event/message — streaming escape hatch (parity with `CompleteResult.raw`). */
  raw?: unknown;
}

/**
 * Streaming-request options. Same shape as `CompleteOptions` minus the
 * `signal` (kept) — kept identical to make swapping `complete` /
 * `streamComplete` mechanical.
 */
export type StreamCompleteOptions = CompleteOptions;

/**
 * Embeddings — vector representation of input text(s). One adapter call
 * may embed multiple inputs in a single batch.
 */
export interface EmbedOptions {
  model: string;
  /** One or more strings to embed. Adapters may chunk into provider-permitted batch sizes. */
  inputs: string[];
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export interface EmbedResult {
  model: string;
  /** One vector per input, in the same order. */
  embeddings: number[][];
  usage: { inputTokens: number };
}
