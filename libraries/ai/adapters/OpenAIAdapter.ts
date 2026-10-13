import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
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
 * Concrete `LLMProvider` implementation backed by `openai`.
 *
 * Translation surface:
 *   - Cross-provider `Message` (string-or-content-parts) →
 *     `ChatCompletionMessageParam[]`. System prompt is prepended as a
 *     `role: "system"` message (OpenAI convention) rather than a
 *     top-level field. Tool-results from our content-parts shape map
 *     to `role: "tool"` messages.
 *   - `ToolDefinition` → OpenAI "function" tool (`type: "function"`,
 *     `function.parameters` = our `inputSchema`).
 *   - `ToolChoice` (auto / any / none / tool) → OpenAI
 *     `tool_choice` (`auto` / `required` / `none` / `{type: "function",
 *     function: { name }}`).
 *   - `ChatCompletion` response → `CompleteResult` with normalized
 *     `StopReason` (`stop` → `end_turn`, `length` → `max_tokens`,
 *     `content_filter` → `content_filter`, `tool_calls` →
 *     `tool_use`).
 *   - `ChatCompletionChunk` stream → normalized `StreamEvent` stream.
 *     Tool-call argument deltas accumulate per `tool_calls[index]`
 *     and emit the parsed object on the matching tool-call's first
 *     `finish_reason` chunk.
 *
 * Constructor takes either an `apiKey` or a pre-built `client`
 * (structurally typed via `OpenAIChatClient`) — tests inject a stub
 * without monkey-patching the SDK module.
 *
 * Default model: `gpt-4.1` (the most capable production GPT as of v4
 * launch). Callers override per request via `opts.model`.
 *
 * Default `max_tokens` (4096) applied when caller doesn't supply one;
 * paired with the Anthropic adapter's same default for cross-provider
 * call-site parity.
 */

export interface OpenAIAdapterOptions {
  /** OpenAI API key. Required unless `client` is supplied. */
  apiKey?: string;
  /** Override the default OpenAI API base URL. */
  baseURL?: string;
  /** Forwarded as `defaultHeaders` to the SDK. */
  defaultHeaders?: Record<string, string>;
  /**
   * Pre-built / stubbed SDK client. When supplied, `apiKey` /
   * `baseURL` are ignored — useful for tests and for shared client
   * reuse.
   */
  client?: OpenAIChatClient;
  /** Default `max_tokens` when caller doesn't supply one. Defaults 4096. */
  defaultMaxTokens?: number;
}

/**
 * Structural slice of `OpenAI` we actually call — narrows what tests
 * have to stub. The real `OpenAI` client satisfies this trivially.
 */
export interface OpenAIChatClient {
  chat: {
    completions: {
      create(
        body: ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<ChatCompletion>;
      create(
        body: ChatCompletionCreateParamsStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<AsyncIterable<ChatCompletionChunk>>;
      create(
        body: ChatCompletionCreateParamsBase,
        options?: { signal?: AbortSignal },
      ): Promise<ChatCompletion | AsyncIterable<ChatCompletionChunk>>;
    };
  };
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "gpt-4.1";

export class OpenAIAdapter implements LLMProvider {
  readonly name = "openai";

  private readonly client: OpenAIChatClient;
  private readonly defaultMaxTokens: number;

  constructor(opts: OpenAIAdapterOptions = {}) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) {
        throw new Error("OpenAIAdapter requires `apiKey` or a pre-built `client`");
      }
      this.client = new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
        defaultHeaders: opts.defaultHeaders,
      }) as unknown as OpenAIChatClient;
    }
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const body = this.buildRequestBody(opts, false) as ChatCompletionCreateParamsNonStreaming;
    const response = (await this.client.chat.completions.create(body, {
      signal: opts.signal,
    })) as ChatCompletion;
    return translateResponse(response);
  }

  async *streamComplete(opts: StreamCompleteOptions): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(opts, true) as ChatCompletionCreateParamsStreaming;
    const stream = (await this.client.chat.completions.create(body, {
      signal: opts.signal,
    })) as AsyncIterable<ChatCompletionChunk>;

    let started = false;
    let stopReason: StopReason = "unknown";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    // Per-tool-call index buffers — OpenAI streams tool_call argument
    // deltas indexed by `tool_calls[i].index`. We accumulate args and
    // emit `tool_use_end` when finish_reason fires.
    const toolBuffers = new Map<
      number,
      { id: string; name: string; emitted: boolean; args: string }
    >();

    for await (const chunk of stream) {
      if (!started) {
        started = true;
        yield { type: "start", id: chunk.id, model: chunk.model };
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text_delta", delta: delta.content };
      }

      const toolCallDeltas = delta.tool_calls;
      if (toolCallDeltas) {
        for (const tc of toolCallDeltas) {
          const idx = tc.index;
          let buf = toolBuffers.get(idx);
          if (!buf) {
            buf = {
              id: tc.id ?? `tu_${idx}`,
              name: tc.function?.name ?? "",
              emitted: false,
              args: "",
            };
            toolBuffers.set(idx, buf);
          }
          // The first chunk for a given index typically carries the id
          // + name; subsequent chunks carry only argument fragments.
          if (tc.id && !buf.id.startsWith("tu_")) buf.id = tc.id;
          else if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (!buf.emitted && buf.name) {
            yield { type: "tool_use_start", id: buf.id, name: buf.name };
            buf.emitted = true;
          }
          const partial = tc.function?.arguments;
          if (partial) {
            buf.args += partial;
            yield {
              type: "tool_input_delta",
              id: buf.id,
              partialJson: partial,
            };
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = translateStopReason(choice.finish_reason);
      }

      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }

    // Close out any outstanding tool-call buffers with parsed inputs.
    for (const buf of toolBuffers.values()) {
      const input = parseToolArgs(buf.args);
      yield { type: "tool_use_end", id: buf.id, input };
    }

    yield { type: "stop", stopReason, usage };
  }

  // --- Translation helpers ------------------------------------------------

  private buildRequestBody(opts: CompleteOptions, stream: boolean): ChatCompletionCreateParamsBase {
    const messages: ChatCompletionMessageParam[] = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.system });
    }
    for (const msg of opts.messages) {
      pushTranslatedMessage(messages, msg);
    }

    const body: ChatCompletionCreateParamsBase = {
      model: opts.model || DEFAULT_MODEL,
      messages,
      max_completion_tokens: opts.maxTokens ?? this.defaultMaxTokens,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.stopSequences?.length) body.stop = opts.stopSequences;
    if (opts.tools?.length) body.tools = opts.tools.map(toOpenAITool);
    if (opts.toolChoice) body.tool_choice = toOpenAIToolChoice(opts.toolChoice);
    if (opts.metadata) {
      body.metadata = opts.metadata as Record<string, string>;
    }
    if (stream) {
      (body as ChatCompletionCreateParamsStreaming).stream = true;
      // Ask for usage on streaming responses (off by default).
      (body as ChatCompletionCreateParamsStreaming).stream_options = { include_usage: true };
    }
    if (opts.providerOptions) Object.assign(body, opts.providerOptions);
    return body;
  }
}

function pushTranslatedMessage(messages: ChatCompletionMessageParam[], msg: Message): void {
  if (msg.role === "tool") {
    // Cross-provider `Message` doesn't model OpenAI's tool-result
    // message directly. Caller should have used content-part shape;
    // this branch is defensive.
    if (typeof msg.content === "string") {
      messages.push({
        role: "tool",
        tool_call_id: msg.name ?? "",
        content: msg.content,
      });
    } else {
      // Multi-part tool message — flatten text parts.
      messages.push({
        role: "tool",
        tool_call_id: msg.name ?? "",
        content: contentPartsToString(msg.content),
      });
    }
    return;
  }

  if (msg.role === "assistant") {
    const param = translateAssistantMessage(msg);
    messages.push(param);
    return;
  }

  // role === "user"
  if (typeof msg.content === "string") {
    messages.push({ role: "user", content: msg.content });
    return;
  }

  // Multi-part user content: text + image directly; tool_result split
  // into separate role:"tool" messages because OpenAI's chat schema
  // requires tool-results as their own messages, not embedded user
  // content.
  const userContent: Array<
    | { type: "text"; text: string }
    | {
        type: "image_url";
        image_url: { url: string };
      }
  > = [];
  const trailingToolResults: ChatCompletionMessageParam[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      userContent.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:${part.mediaType};base64,${part.data}` },
      });
    } else if (part.type === "tool_result") {
      trailingToolResults.push({
        role: "tool",
        tool_call_id: part.toolUseId,
        content: part.content,
      });
    }
    // tool_use parts are valid only on assistant messages — skip on user.
  }
  if (userContent.length > 0) {
    messages.push({ role: "user", content: userContent });
  }
  for (const tr of trailingToolResults) messages.push(tr);
}

function translateAssistantMessage(msg: Message): ChatCompletionMessageParam {
  if (typeof msg.content === "string") {
    return { role: "assistant", content: msg.content };
  }
  const text: string[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      text.push(part.text);
    } else if (part.type === "tool_use") {
      toolCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
    }
  }
  const out: ChatCompletionMessageParam = {
    role: "assistant",
    content: text.length > 0 ? text.join("") : null,
  };
  if (toolCalls.length > 0) {
    (out as { tool_calls?: ChatCompletionMessageToolCall[] }).tool_calls = toolCalls;
  }
  return out;
}

function contentPartsToString(parts: MessageContentPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function toOpenAITool(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

function toOpenAIToolChoice(choice: ToolChoice): ChatCompletionToolChoiceOption {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}

function translateResponse(response: ChatCompletion): CompleteResult {
  const choice = response.choices[0];
  const message = choice?.message;
  const content: MessageContentPart[] = [];
  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type !== "function" && !("function" in tc)) continue;
      const fn = "function" in tc ? tc.function : undefined;
      if (!fn) continue;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch {
        // OpenAI may emit invalid JSON on truncated responses — keep
        // the raw text on a sentinel field so consumers can recover.
        input = { __ship_api_raw: fn.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: fn.name,
        input,
      });
    }
  }
  const text = content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  const usage: TokenUsage = {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    raw: response.usage,
  };
  const reasoningTokens = (
    response.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined
  )?.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;

  const result: CompleteResult = {
    id: response.id,
    model: response.model,
    content,
    text,
    stopReason: translateStopReason(choice?.finish_reason ?? null),
    usage,
    raw: response,
  };
  // Pass native fields the unified surface drops through `providerExtras` (AI-R1).
  if (message?.refusal) result.providerExtras = { refusal: message.refusal };
  return result;
}

function translateStopReason(
  reason: ChatCompletion.Choice["finish_reason"] | string | null,
): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return "unknown";
  }
}

function parseToolArgs(buffer: string): Record<string, unknown> {
  if (!buffer) return {};
  try {
    return JSON.parse(buffer) as Record<string, unknown>;
  } catch {
    return { __ship_api_partial: buffer };
  }
}
