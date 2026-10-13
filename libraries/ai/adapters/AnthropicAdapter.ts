import Anthropic from "@anthropic-ai/sdk";
import type {
  Message as AnthropicMessage,
  Tool as AnthropicTool,
  ToolChoice as AnthropicToolChoice,
  MessageCreateParamsBase,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import type {
  CompleteOptions,
  CompleteResult,
  Message,
  MessageContentPart,
  StopReason,
  StreamCompleteOptions,
  StreamEvent,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../types.js";
import type { LLMProvider } from "./LLMProvider.js";

/**
 * Concrete `LLMProvider` implementation backed by `@anthropic-ai/sdk`.
 *
 * Translation surface:
 *   - Cross-provider `Message` (text-or-content-parts) → Anthropic
 *     `MessageParam[]` (top-level `system` extracted out per API
 *     convention).
 *   - `ToolDefinition` → Anthropic `Tool` (passes `inputSchema` through
 *     as `input_schema` — both are JSON Schema).
 *   - Anthropic `Message` response → `CompleteResult` with normalized
 *     `StopReason` + `TokenUsage` (cache reads/creation surfaced when
 *     present so cost trackers can see them).
 *   - Anthropic `RawMessageStreamEvent` → normalized `StreamEvent`
 *     stream — buffers tool-use input JSON deltas and emits the parsed
 *     object on `content_block_stop` so consumers don't have to
 *     re-implement the buffer.
 *
 * Constructor takes either an `apiKey` (the common case — instantiates
 * the SDK internally) or a pre-built `client` (tests inject a stub
 * implementing `client.messages.create(...)`; lets us drive end-to-end
 * translation without monkey-patching the SDK module).
 *
 * Error normalization across providers lands in a later commit (along
 * with `LLMProviderError`); for now SDK errors propagate as-is.
 *
 * Default model: `claude-opus-4-7` (the most capable Claude as of v4
 * launch). Callers override per request via `opts.model`.
 */

export interface AnthropicAdapterOptions {
  /** Anthropic API key. Required unless `client` is supplied. */
  apiKey?: string;
  /** Override the default Anthropic API base URL. */
  baseURL?: string;
  /** Forwarded as `defaultHeaders` to the SDK. */
  defaultHeaders?: Record<string, string>;
  /**
   * Pre-built / stubbed SDK client. When supplied, `apiKey` / `baseURL`
   * are ignored — useful for tests and for shared client reuse.
   */
  client?: AnthropicMessagesClient;
  /** Default `max_tokens` when caller doesn't supply one. Defaults 4096. */
  defaultMaxTokens?: number;
}

/**
 * Structural slice of `Anthropic` we actually call — narrows what tests
 * have to stub. The real `Anthropic` client satisfies this trivially.
 */
export interface AnthropicMessagesClient {
  messages: {
    create(
      body: MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessage>;
    create(
      body: MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<RawMessageStreamEvent>>;
    create(
      body: MessageCreateParamsBase,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessage | AsyncIterable<RawMessageStreamEvent>>;
  };
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "claude-opus-4-7";

export class AnthropicAdapter implements LLMProvider {
  readonly name = "anthropic";

  private readonly client: AnthropicMessagesClient;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicAdapterOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) {
        throw new Error("AnthropicAdapter requires `apiKey` or a pre-built `client`");
      }
      this.client = new Anthropic({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
        defaultHeaders: opts.defaultHeaders,
      }) as unknown as AnthropicMessagesClient;
    }
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const body = this.buildRequestBody(opts, false) as MessageCreateParamsNonStreaming;
    const response = (await this.client.messages.create(body, {
      signal: opts.signal,
    })) as AnthropicMessage;
    return this.translateResponse(response);
  }

  async *streamComplete(opts: StreamCompleteOptions): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(opts, true) as MessageCreateParamsStreaming;
    const stream = (await this.client.messages.create(body, {
      signal: opts.signal,
    })) as AsyncIterable<RawMessageStreamEvent>;

    // Indexed buffers: Anthropic identifies content blocks by `index` (a
    // turn-local integer); we map index → adapter-issued ID + buffered
    // input JSON for tool-use blocks.
    const blocks = new Map<
      number,
      { kind: "text" } | { kind: "tool_use"; id: string; name: string; jsonBuffer: string }
    >();
    let stopReason: StopReason = "unknown";
    let stopSequence: string | undefined;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of stream) {
      switch (event.type) {
        case "message_start": {
          const msg = event.message;
          usage = translateUsage(msg.usage);
          yield { type: "start", id: msg.id, model: msg.model };
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "text") {
            blocks.set(event.index, { kind: "text" });
          } else if (block.type === "tool_use") {
            blocks.set(event.index, {
              kind: "tool_use",
              id: block.id,
              name: block.name,
              jsonBuffer: "",
            });
            yield { type: "tool_use_start", id: block.id, name: block.name };
          }
          // Other block kinds (thinking, server_tool_use, …) are not yet
          // surfaced through the cross-provider stream — adapters can
          // expand the StreamEvent union in a later commit.
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(event.index);
          if (!block) break;
          const delta = event.delta;
          if (delta.type === "text_delta" && block.kind === "text") {
            yield { type: "text_delta", delta: delta.text };
          } else if (delta.type === "input_json_delta" && block.kind === "tool_use") {
            block.jsonBuffer += delta.partial_json;
            yield {
              type: "tool_input_delta",
              id: block.id,
              partialJson: delta.partial_json,
            };
          }
          break;
        }
        case "content_block_stop": {
          const block = blocks.get(event.index);
          if (block?.kind === "tool_use") {
            const input = parseToolInput(block.jsonBuffer);
            yield { type: "tool_use_end", id: block.id, input };
          }
          blocks.delete(event.index);
          break;
        }
        case "message_delta": {
          if (event.delta.stop_reason) stopReason = translateStopReason(event.delta.stop_reason);
          if (event.delta.stop_sequence) stopSequence = event.delta.stop_sequence;
          // Output tokens accumulate in message_delta's usage.
          if (event.usage) {
            usage = {
              ...usage,
              outputTokens: event.usage.output_tokens,
            };
          }
          break;
        }
        case "message_stop": {
          yield { type: "stop", stopReason, stopSequence, usage };
          break;
        }
      }
    }
  }

  // --- Translation helpers ------------------------------------------------

  private buildRequestBody(
    opts: CompleteOptions,
    stream: boolean,
  ): MessageCreateParamsBase & { stream?: boolean } {
    const body: MessageCreateParamsBase & { stream?: boolean } = {
      model: opts.model || DEFAULT_MODEL,
      messages: opts.messages.map(toAnthropicMessage),
      max_tokens: opts.maxTokens ?? this.defaultMaxTokens,
    };
    if (opts.system) body.system = opts.system;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.stopSequences?.length) body.stop_sequences = opts.stopSequences;
    if (opts.tools?.length) body.tools = opts.tools.map(toAnthropicTool);
    if (opts.toolChoice) body.tool_choice = toAnthropicToolChoice(opts.toolChoice);
    if (opts.metadata) body.metadata = opts.metadata as { user_id?: string };
    if (opts.providerOptions) Object.assign(body, opts.providerOptions);
    if (stream) body.stream = true;
    return body;
  }

  private translateResponse(response: AnthropicMessage): CompleteResult {
    const content: MessageContentPart[] = [];
    const extraBlocks: unknown[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: ((block as ToolUseBlock).input ?? {}) as Record<string, unknown>,
        });
      } else {
        // Native blocks not on the cross-provider surface (thinking,
        // redacted_thinking, citations, server_tool_use, …): pass them
        // THROUGH `providerExtras` rather than drop them (AI-R1). The full
        // untranslated response is also on `raw` below.
        extraBlocks.push(block);
      }
    }
    const text = content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");

    const result: CompleteResult = {
      id: response.id,
      model: response.model,
      content,
      text,
      stopReason: translateStopReason(response.stop_reason),
      stopSequence: response.stop_sequence ?? undefined,
      usage: translateUsage(response.usage),
      raw: response,
    };
    if (extraBlocks.length > 0) result.providerExtras = { blocks: extraBlocks };
    return result;
  }
}

function toAnthropicMessage(msg: Message): MessageParam {
  // Anthropic supports user/assistant roles in the messages array;
  // tool-result messages are encoded as user messages with a
  // `tool_result` content block per Anthropic API convention.
  const role: MessageParam["role"] = msg.role === "assistant" ? "assistant" : "user";

  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  // biome-ignore lint/suspicious/useIterableCallbackReturn: MessageContentPart is a closed discriminated union and every member returns.
  const blocks = msg.content.map((part) => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text } as const;
      case "tool_use":
        return {
          type: "tool_use",
          id: part.id,
          name: part.name,
          input: part.input,
        } as const;
      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: part.toolUseId,
          content: part.content,
          is_error: part.isError ?? false,
        } as const;
      case "image":
        return {
          type: "image",
          source: {
            type: "base64" as const,
            media_type: part.mediaType,
            data: part.data,
          },
        } as const;
    }
  });

  return { role, content: blocks } as MessageParam;
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as AnthropicTool["input_schema"],
  };
}

function toAnthropicToolChoice(choice: ToolChoice): AnthropicToolChoice {
  switch (choice.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

function translateStopReason(
  reason: AnthropicMessage["stop_reason"] | string | null | undefined,
): StopReason {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
    case "tool_use":
      return reason;
    case "refusal":
      return "content_filter";
    case "pause_turn":
      // Treat extended-thinking pause as end-of-turn for cross-provider
      // simplicity; consumers needing the distinction should target the
      // Anthropic SDK directly.
      return "end_turn";
    default:
      return "unknown";
  }
}

function translateUsage(usage: AnthropicMessage["usage"]): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
    raw: usage,
  };
}

function parseToolInput(buffer: string): Record<string, unknown> {
  if (!buffer) return {};
  try {
    return JSON.parse(buffer) as Record<string, unknown>;
  } catch {
    // The Anthropic stream guarantees valid JSON when complete; if we
    // get here the upstream call was canceled mid-stream.
    return { __ship_api_partial: buffer };
  }
}
