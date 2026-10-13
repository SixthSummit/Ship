import type { Message, MessageContentPart } from "../types.js";

/**
 * Pluggable tokenizer contract — counts tokens for a given model
 * without committing the library to a specific tokenizer
 * implementation (tiktoken / claude-tokenizer / model-bundled
 * /encoding-rs / online API). Consumers inject the right tokenizer
 * for their provider; this library never imports a tokenizer SDK
 * itself, so the dep graph stays narrow.
 *
 * Why an interface instead of "just use tiktoken":
 *   - Tokenization is provider-specific. OpenAI uses tiktoken (cl100k /
 *     o200k); Anthropic uses a Claude-specific BPE; Llama / Mistral
 *     have their own. One library, three tokenizers.
 *   - Tiktoken pulls a 5+ MB WASM blob — fine for server-side, hostile
 *     for edge runtimes. An "estimate" tokenizer is preferable when
 *     exactness doesn't matter (rate-limit budgeting, prompt-fit
 *     gating).
 *   - Tests need a predictable in-process tokenizer; consumers can
 *     register `HeuristicTokenizer` for cheap deterministic counts.
 *
 * The library ships `HeuristicTokenizer` as a baseline (~4 chars per
 * token, the well-known rule-of-thumb for English). Real tokenizers
 * (tiktoken-backed for OpenAI, claude-tokenizer for Anthropic) are
 * straightforward to implement against this interface and can land in
 * v4.x adapter sub-packages so they're tree-shake-friendly.
 */

export interface Tokenizer {
  /** Stable model identifier the tokenizer is calibrated for. */
  readonly model: string;
  /**
   * Count tokens in a single string. Synchronous so callers can use it
   * inside hot prompt-assembly loops without await ceremony.
   */
  count(text: string): number;
  /**
   * Optional encode (text → tokens). Provided when the tokenizer is
   * exact (tiktoken / claude); omitted on heuristic backends.
   */
  encode?(text: string): number[];
  /** Optional decode (tokens → text). Same caveat as `encode`. */
  decode?(tokens: number[]): string;
  /**
   * Free any resources the tokenizer holds (tiktoken WASM handles,
   * file mappings). Idempotent. Safe to call when nothing was
   * allocated.
   */
  dispose?(): void;
}

/**
 * Sum tokens across a `Message[]` history — text parts, tool_use
 * input JSON, tool_result content, image part overhead. Provider-
 * specific message-formatting overhead (per-turn separator tokens,
 * role-name tokens) is approximated by `perMessageOverhead`; refine
 * per provider when exactness matters.
 */
export interface CountMessagesOptions {
  /** Tokens added per message (separators / role name). Default 4. */
  perMessageOverhead?: number;
  /**
   * Tokens budgeted per image part. Anthropic / OpenAI both charge a
   * fixed-ish range (~85–1500 depending on resolution). Default 1024
   * — middle of the range; pass a tighter estimate when known.
   */
  perImageTokens?: number;
}

const DEFAULT_PER_MESSAGE_OVERHEAD = 4;
const DEFAULT_PER_IMAGE_TOKENS = 1024;

/**
 * @deprecated AI-R3. Token *truth* comes back in the provider response — read
 * `CompleteResult.usage` / `StreamStopEvent.usage` (real, billed counts). This
 * heuristic-driven count is inaccurate (±15%) and a per-model maintenance
 * burden. For pre-call budgeting only, use `estimateMessageTokens`.
 */
export function countMessageTokens(
  tokenizer: Tokenizer,
  messages: Message[],
  opts: CountMessagesOptions = {},
): number {
  const perMessage = opts.perMessageOverhead ?? DEFAULT_PER_MESSAGE_OVERHEAD;
  const perImage = opts.perImageTokens ?? DEFAULT_PER_IMAGE_TOKENS;

  let total = 0;
  for (const msg of messages) {
    total += perMessage;
    if (typeof msg.content === "string") {
      total += tokenizer.count(msg.content);
    } else {
      total += countParts(tokenizer, msg.content, perImage);
    }
    if (msg.name) total += tokenizer.count(msg.name);
  }
  return total;
}

function countParts(tokenizer: Tokenizer, parts: MessageContentPart[], perImage: number): number {
  let n = 0;
  for (const p of parts) {
    switch (p.type) {
      case "text":
        n += tokenizer.count(p.text);
        break;
      case "tool_use":
        n += tokenizer.count(p.name);
        // input JSON shows up to the model verbatim — count it.
        try {
          n += tokenizer.count(JSON.stringify(p.input ?? {}));
        } catch {
          // unrenderable input → conservative estimate
          n += 16;
        }
        break;
      case "tool_result":
        n += tokenizer.count(p.content);
        break;
      case "image":
        n += perImage;
        break;
    }
  }
  return n;
}

/**
 * Heuristic tokenizer — `Math.ceil(text.length / 4)`, the canonical
 * rule-of-thumb for English text. ±15% accuracy; good enough for
 * rate-limit budgeting and prompt-fit gating, not for exact billing.
 *
 * Ships zero deps and works in every runtime (Node, Workers, Bun,
 * browser). Real tokenizers swap in via the `Tokenizer` interface
 * without changing call sites.
 *
 * @deprecated AI-R3. Token truth comes back in the provider response — read
 * `CompleteResult.usage`. Use this only as a pre-call estimate; the standalone
 * `estimateTokens` / `estimateMessageTokens` helpers are the lighter, honestly-
 * labelled way to do that without a pluggable-tokenizer subsystem. The
 * `Tokenizer` interface itself is NOT deprecated — a real tiktoken/claude
 * tokenizer still implements it.
 */
export class HeuristicTokenizer implements Tokenizer {
  readonly model: string;
  private readonly charsPerToken: number;

  constructor(opts: { model?: string; charsPerToken?: number } = {}) {
    this.model = opts.model ?? "heuristic";
    this.charsPerToken = opts.charsPerToken ?? 4;
  }

  count(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }
}

const ESTIMATE_CHARS_PER_TOKEN = 4;

/**
 * Rough pre-call token **estimate** for a single string (`~chars/4`). For
 * prompt-fit / rate-limit gating *before* a request exists — NOT a billing
 * figure (the real count is returned by the provider on the response,
 * `CompleteResult.usage`). ±15%; zero-dep; works in every runtime.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * Rough pre-call token **estimate** for a `Message[]` history — sums text,
 * tool-use input JSON, tool-result content, plus per-message and per-image
 * overhead. ESTIMATE ONLY, for prompt-fit gating before the request exists;
 * read the response `usage` for real counts. (This is the honest replacement
 * for the deprecated `countMessageTokens`.)
 */
export function estimateMessageTokens(
  messages: Message[],
  opts: CountMessagesOptions = {},
): number {
  const perMessage = opts.perMessageOverhead ?? DEFAULT_PER_MESSAGE_OVERHEAD;
  const perImage = opts.perImageTokens ?? DEFAULT_PER_IMAGE_TOKENS;
  let total = 0;
  for (const msg of messages) {
    total += perMessage;
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else {
      for (const p of msg.content) {
        switch (p.type) {
          case "text":
            total += estimateTokens(p.text);
            break;
          case "tool_use":
            total += estimateTokens(p.name);
            try {
              total += estimateTokens(JSON.stringify(p.input ?? {}));
            } catch {
              total += 16;
            }
            break;
          case "tool_result":
            total += estimateTokens(p.content);
            break;
          case "image":
            total += perImage;
            break;
        }
      }
    }
    if (msg.name) total += estimateTokens(msg.name);
  }
  return total;
}
