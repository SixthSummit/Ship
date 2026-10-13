import type {
  CompleteOptions,
  CompleteResult,
  EmbedOptions,
  EmbedResult,
  StreamCompleteOptions,
  StreamEvent,
} from "../types.js";

/**
 * Pluggable LLM provider contract — the v4 LLM helper library's load-
 * bearing seam. Every adapter (Anthropic, OpenAI, Bedrock-via-bedrock,
 * Vertex, local Ollama, …) implements this surface; downstream code
 * (agent loop, prompt registry, RAG pipeline, `streamLLM(c, ...)`)
 * targets the interface, not a concrete provider.
 *
 * Provider-specific tunables ride in `CompleteOptions.providerOptions`
 * so the cross-provider surface stays narrow. Provider-specific outputs
 * ride in `CompleteResult.providerExtras` (e.g. Anthropic prompt-cache
 * metadata) for the same reason.
 *
 * Why pluggable instead of "just use Anthropic": (1) cost-routing —
 * cheap local models for development, frontier models for production;
 * (2) graceful degradation — fall back to a different provider when one
 * is degraded; (3) consumer choice — the framework doesn't pre-decide
 * which provider a downstream app uses; (4) testability — a `MockLLM`
 * adapter implementing this interface drives every higher-level
 * abstraction (agent loop, structured output) without the network.
 *
 * Adapters MUST:
 *   - Convert provider-specific stop reasons / usage shapes to the
 *     normalized `StopReason` / `TokenUsage` types.
 *   - Aggregate streaming chunks into the well-defined `StreamEvent`
 *     order (`start` → `text_delta` / tool-call group(s) → `stop`).
 *   - Honor `opts.signal` — abort the in-flight provider request when
 *     the signal fires; rejecting the returned promise / iterator.
 *   - Normalize transient failures into a thrown `LLMProviderError`
 *     (later commit defines this) so callers don't switch on SDK type.
 *
 * Adapters SHOULD:
 *   - Accept an injected `fetch` / SDK client in their constructor so
 *     tests can swap it without monkey-patching globals.
 *   - Default to the provider's IANA-blessed base URL but allow
 *     override via constructor option (corp proxies, edge gateways).
 *   - Set request-level metadata (e.g. `metadata.user_id`) when the
 *     caller passes `opts.metadata` — used by usage trackers (v4.x).
 */
export interface LLMProvider {
  /** Stable identifier ("anthropic", "openai", "bedrock", …). */
  readonly name: string;

  /**
   * Single-turn completion. Resolves with the full response (all
   * content parts the model emitted, normalized stop reason, token
   * usage). Rejects with `LLMProviderError` on transient failures or
   * `AbortError` when `opts.signal` fires.
   */
  complete(opts: CompleteOptions): Promise<CompleteResult>;

  /**
   * Streaming variant. Returns an async iterator of `StreamEvent`s in
   * the documented order (`start` → deltas → `stop`). Consumers
   * `for await` to drive UI / `streamSSE`. The iterator throws on
   * abort (`opts.signal`) or transient failure — callers wrap in
   * try/catch when they need recovery.
   */
  streamComplete(opts: StreamCompleteOptions): AsyncIterable<StreamEvent>;

  /**
   * Embed one or more strings. Optional — providers without embeddings
   * may throw `LLMProviderUnsupportedError` (later commit) instead.
   * Adapters that DO support embeddings must batch internally to
   * respect provider per-request input limits.
   */
  embed?(opts: EmbedOptions): Promise<EmbedResult>;
}
