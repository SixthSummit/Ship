import type {
  Message as AnthropicMessage,
  MessageCreateParamsBase,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { describe, expect, it, vi } from "vitest";
import type { CompleteOptions, StreamEvent } from "../types.js";
import { AnthropicAdapter, type AnthropicMessagesClient } from "./AnthropicAdapter.js";

function buildResponse(overrides: Partial<AnthropicMessage> = {}): AnthropicMessage {
  return {
    id: "msg_001",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-7",
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    container: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  } as AnthropicMessage;
}

/** Build a minimal stub client whose `messages.create` returns the queued result. */
function stubClient(result: AnthropicMessage | AsyncIterable<RawMessageStreamEvent>): {
  client: AnthropicMessagesClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => result);
  return {
    client: { messages: { create: spy as unknown } } as AnthropicMessagesClient,
    spy,
  };
}

describe("AnthropicAdapter", () => {
  describe("construction", () => {
    it("throws when neither apiKey nor client is supplied", () => {
      expect(() => new AnthropicAdapter()).toThrow(/apiKey/);
    });

    it("accepts a pre-built client without an apiKey", () => {
      const { client } = stubClient(buildResponse());
      expect(() => new AnthropicAdapter({ client })).not.toThrow();
    });
  });

  describe("complete", () => {
    it("translates a string-content user message + system prompt", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new AnthropicAdapter({ client });

      await adapter.complete({
        model: "claude-opus-4-7",
        system: "you are concise",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(spy).toHaveBeenCalledOnce();
      const body = spy.mock.calls[0][0] as MessageCreateParamsBase;
      expect(body.model).toBe("claude-opus-4-7");
      expect(body.system).toBe("you are concise");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(body.max_tokens).toBe(4096);
    });

    it("respects caller-supplied max_tokens, temperature, stop_sequences", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new AnthropicAdapter({ client });

      await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 256,
        temperature: 0.2,
        stopSequences: ["END"],
      });

      const body = spy.mock.calls[0][0] as MessageCreateParamsBase;
      expect(body.max_tokens).toBe(256);
      expect(body.temperature).toBe(0.2);
      expect(body.stop_sequences).toEqual(["END"]);
    });

    it("translates content-part user message with tool_result and image", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new AnthropicAdapter({ client });

      await adapter.complete({
        model: "claude-opus-4-7",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see this:" },
              {
                type: "image",
                mediaType: "image/png",
                data: "Zm9v", // base64 "foo"
              },
              {
                type: "tool_result",
                toolUseId: "tu_1",
                content: '{"ok":true}',
              },
            ],
          },
        ],
      });

      const body = spy.mock.calls[0][0] as MessageCreateParamsBase;
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "see this:" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "Zm9v" },
        },
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: '{"ok":true}',
          is_error: false,
        },
      ]);
    });

    it("translates tools + toolChoice", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new AnthropicAdapter({ client });

      await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "use the tool" }],
        tools: [
          {
            name: "get_weather",
            description: "Look up weather by city",
            inputSchema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
        toolChoice: { type: "tool", name: "get_weather" },
      });

      const body = spy.mock.calls[0][0] as MessageCreateParamsBase;
      expect(body.tools).toEqual([
        {
          name: "get_weather",
          description: "Look up weather by city",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ]);
      expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    });

    it("translates response: text + tool_use blocks → CompleteResult", async () => {
      const { client } = stubClient(
        buildResponse({
          content: [
            { type: "text", text: "I'll check the weather." },
            {
              type: "tool_use",
              id: "tu_42",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
          stop_reason: "tool_use",
        } as Partial<AnthropicMessage>),
      );
      const adapter = new AnthropicAdapter({ client });

      const result = await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "weather in Paris?" }],
      });

      expect(result.id).toBe("msg_001");
      expect(result.stopReason).toBe("tool_use");
      expect(result.text).toBe("I'll check the weather.");
      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toEqual({
        type: "tool_use",
        id: "tu_42",
        name: "get_weather",
        input: { city: "Paris" },
      });
      expect(result.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: undefined,
        cacheCreationInputTokens: undefined,
      });
      // AI-R1: the full provider response + usage ride along on `raw`.
      expect(result.usage.raw).toBeDefined();
      expect(result.raw).toBeDefined();
    });

    it("passes native blocks (thinking, …) through providerExtras, not dropping them (AI-R1)", async () => {
      const { client } = stubClient(
        buildResponse({
          content: [
            { type: "thinking", thinking: "let me reason", signature: "sig" },
            { type: "text", text: "the answer" },
          ],
        } as Partial<AnthropicMessage>),
      );
      const adapter = new AnthropicAdapter({ client });
      const result = await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "q" }],
      });
      // The text part is on the unified surface; the thinking block is NOT
      // dropped — it passes through providerExtras.blocks (plus the full raw).
      expect(result.text).toBe("the answer");
      const extras = result.providerExtras as { blocks: { type: string }[] } | undefined;
      expect(extras?.blocks.some((b) => b.type === "thinking")).toBe(true);
      expect(result.raw).toBeDefined();
    });

    it("translates `refusal` stop_reason to normalized `content_filter`", async () => {
      const { client } = stubClient(
        buildResponse({
          stop_reason: "refusal",
        } as Partial<AnthropicMessage>),
      );
      const adapter = new AnthropicAdapter({ client });
      const result = await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "x" }],
      });
      expect(result.stopReason).toBe("content_filter");
    });

    it("surfaces cache-read / cache-creation token usage when present", async () => {
      const { client } = stubClient(
        buildResponse({
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 10,
            cache_creation: null,
            server_tool_use: null,
            service_tier: null,
          },
        } as Partial<AnthropicMessage>),
      );
      const adapter = new AnthropicAdapter({ client });
      const result = await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "x" }],
      });
      expect(result.usage.cacheReadInputTokens).toBe(80);
      expect(result.usage.cacheCreationInputTokens).toBe(10);
    });

    it("forwards AbortSignal through the SDK request options", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new AnthropicAdapter({ client });
      const ac = new AbortController();
      await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "x" }],
        signal: ac.signal,
      });
      expect(spy.mock.calls[0][1]).toEqual({ signal: ac.signal });
    });

    it("merges providerOptions onto the request body", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new AnthropicAdapter({ client });
      await adapter.complete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "x" }],
        providerOptions: { top_k: 50 },
      });
      const body = spy.mock.calls[0][0] as MessageCreateParamsBase & {
        top_k?: number;
      };
      expect(body.top_k).toBe(50);
    });
  });

  describe("streamComplete", () => {
    it("normalizes a text-only stream into start → text_delta → stop", async () => {
      const events: RawMessageStreamEvent[] = [
        {
          type: "message_start",
          message: buildResponse({
            content: [],
            usage: {
              input_tokens: 8,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              cache_creation: null,
              server_tool_use: null,
              service_tier: null,
            },
          } as Partial<AnthropicMessage>),
        } as RawMessageStreamEvent,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        } as RawMessageStreamEvent,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hel" },
        } as RawMessageStreamEvent,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        } as RawMessageStreamEvent,
        {
          type: "content_block_stop",
          index: 0,
        } as RawMessageStreamEvent,
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        } as RawMessageStreamEvent,
        { type: "message_stop" } as RawMessageStreamEvent,
      ];

      const stream = (async function* () {
        for (const e of events) yield e;
      })();
      const { client } = stubClient(stream);
      const adapter = new AnthropicAdapter({ client });

      const out: StreamEvent[] = [];
      const opts: CompleteOptions = {
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "say hi" }],
      };
      for await (const ev of adapter.streamComplete(opts)) out.push(ev);

      expect(out.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "stop"]);
      expect(out[1]).toEqual({ type: "text_delta", delta: "hel" });
      expect(out[2]).toEqual({ type: "text_delta", delta: "lo" });
      const stop = out[3] as Extract<StreamEvent, { type: "stop" }>;
      expect(stop.stopReason).toBe("end_turn");
      expect(stop.usage.outputTokens).toBe(4);
    });

    it("normalizes a tool-call stream: tool_use_start → tool_input_delta → tool_use_end", async () => {
      const events: RawMessageStreamEvent[] = [
        {
          type: "message_start",
          message: buildResponse({ content: [] } as Partial<AnthropicMessage>),
        } as RawMessageStreamEvent,
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tu_77",
            name: "get_weather",
            input: {},
          },
        } as RawMessageStreamEvent,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        } as RawMessageStreamEvent,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"Paris"}' },
        } as RawMessageStreamEvent,
        { type: "content_block_stop", index: 0 } as RawMessageStreamEvent,
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 12 },
        } as RawMessageStreamEvent,
        { type: "message_stop" } as RawMessageStreamEvent,
      ];

      const stream = (async function* () {
        for (const e of events) yield e;
      })();
      const { client } = stubClient(stream);
      const adapter = new AnthropicAdapter({ client });

      const out: StreamEvent[] = [];
      for await (const ev of adapter.streamComplete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "weather?" }],
      })) {
        out.push(ev);
      }

      expect(out.map((e) => e.type)).toEqual([
        "start",
        "tool_use_start",
        "tool_input_delta",
        "tool_input_delta",
        "tool_use_end",
        "stop",
      ]);
      const end = out[4] as Extract<StreamEvent, { type: "tool_use_end" }>;
      expect(end.id).toBe("tu_77");
      expect(end.input).toEqual({ city: "Paris" });
      const stop = out[5] as Extract<StreamEvent, { type: "stop" }>;
      expect(stop.stopReason).toBe("tool_use");
    });

    it("emits stream: true on streaming requests", async () => {
      const stream = (async function* () {
        yield { type: "message_stop" } as RawMessageStreamEvent;
      })();
      const { client, spy } = stubClient(stream);
      const adapter = new AnthropicAdapter({ client });
      const iter = adapter.streamComplete({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "x" }],
      });
      // Consume so the body actually gets built/sent.
      for await (const _ of iter) void _;
      const body = spy.mock.calls[0][0] as MessageCreateParamsBase & {
        stream?: boolean;
      };
      expect(body.stream).toBe(true);
    });
  });
});
