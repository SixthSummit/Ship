import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../types.js";
import { OpenAIAdapter, type OpenAIChatClient } from "./OpenAIAdapter.js";

function buildResponse(overrides: Partial<ChatCompletion> = {}): ChatCompletion {
  return {
    id: "chatcmpl_001",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4.1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "hello",
          refusal: null,
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  } as ChatCompletion;
}

function stubClient(result: ChatCompletion | AsyncIterable<ChatCompletionChunk>): {
  client: OpenAIChatClient;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(async () => result);
  return {
    client: {
      chat: { completions: { create: spy as unknown } },
    } as OpenAIChatClient,
    spy,
  };
}

describe("OpenAIAdapter", () => {
  describe("construction", () => {
    it("throws when neither apiKey nor client is supplied", () => {
      expect(() => new OpenAIAdapter()).toThrow(/apiKey/);
    });

    it("accepts a pre-built client without an apiKey", () => {
      const { client } = stubClient(buildResponse());
      expect(() => new OpenAIAdapter({ client })).not.toThrow();
    });
  });

  describe("complete", () => {
    it("translates a string-content user message + system prompt (system → role:'system')", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new OpenAIAdapter({ client });

      await adapter.complete({
        model: "gpt-4.1",
        system: "you are concise",
        messages: [{ role: "user", content: "hi" }],
      });

      const body = spy.mock.calls[0][0] as ChatCompletionCreateParamsBase;
      expect(body.messages).toEqual([
        { role: "system", content: "you are concise" },
        { role: "user", content: "hi" },
      ]);
      expect(body.max_completion_tokens).toBe(4096);
    });

    it("translates content-part user message: text + image + tool_result split", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new OpenAIAdapter({ client });

      await adapter.complete({
        model: "gpt-4.1",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "see this:" },
              {
                type: "image",
                mediaType: "image/png",
                data: "Zm9v",
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

      const body = spy.mock.calls[0][0] as ChatCompletionCreateParamsBase;
      // user content should be text + image_url; the tool_result becomes
      // its own role:"tool" message that follows.
      expect(body.messages).toHaveLength(2);
      const userMsg = body.messages[0] as ChatCompletionMessageParam & {
        content: Array<unknown>;
      };
      expect(userMsg.role).toBe("user");
      expect(userMsg.content).toEqual([
        { type: "text", text: "see this:" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,Zm9v" },
        },
      ]);
      const toolMsg = body.messages[1] as ChatCompletionMessageParam & {
        tool_call_id?: string;
      };
      expect(toolMsg.role).toBe("tool");
      expect(toolMsg.tool_call_id).toBe("tu_1");
      expect(toolMsg.content).toBe('{"ok":true}');
    });

    it("translates assistant tool_use content into tool_calls on a role:'assistant' message", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new OpenAIAdapter({ client });

      await adapter.complete({
        model: "gpt-4.1",
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "checking" },
              {
                type: "tool_use",
                id: "tc_1",
                name: "get_weather",
                input: { city: "Paris" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: "tc_1",
                content: '{"tempC":22}',
              },
            ],
          },
        ],
      });

      const body = spy.mock.calls[0][0] as ChatCompletionCreateParamsBase;
      // user / assistant w/ tool_calls / tool
      expect(body.messages).toHaveLength(3);
      const assistantMsg = body.messages[1] as ChatCompletionMessageParam & {
        tool_calls?: Array<unknown>;
      };
      expect(assistantMsg.role).toBe("assistant");
      expect(assistantMsg.content).toBe("checking");
      expect(assistantMsg.tool_calls).toEqual([
        {
          id: "tc_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"Paris"}',
          },
        },
      ]);
      expect(body.messages[2]).toMatchObject({
        role: "tool",
        tool_call_id: "tc_1",
        content: '{"tempC":22}',
      });
    });

    it("translates tools (any/auto/none/tool) into OpenAI tool_choice values", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new OpenAIAdapter({ client });

      const baseOpts = {
        model: "gpt-4.1",
        messages: [{ role: "user" as const, content: "x" }],
        tools: [
          {
            name: "get_weather",
            description: "y",
            inputSchema: { type: "object" },
          },
        ],
      };

      await adapter.complete({ ...baseOpts, toolChoice: { type: "auto" } });
      expect((spy.mock.calls[0][0] as ChatCompletionCreateParamsBase).tool_choice).toBe("auto");

      await adapter.complete({ ...baseOpts, toolChoice: { type: "any" } });
      expect((spy.mock.calls[1][0] as ChatCompletionCreateParamsBase).tool_choice).toBe("required");

      await adapter.complete({ ...baseOpts, toolChoice: { type: "none" } });
      expect((spy.mock.calls[2][0] as ChatCompletionCreateParamsBase).tool_choice).toBe("none");

      await adapter.complete({
        ...baseOpts,
        toolChoice: { type: "tool", name: "get_weather" },
      });
      expect((spy.mock.calls[3][0] as ChatCompletionCreateParamsBase).tool_choice).toEqual({
        type: "function",
        function: { name: "get_weather" },
      });

      // Tool definition forwarded as `type: "function"`.
      const tool = (spy.mock.calls[0][0] as ChatCompletionCreateParamsBase)
        .tools![0] as ChatCompletionTool;
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBe("get_weather");
    });

    it("translates response: text + tool_calls → CompleteResult with tool_use parts", async () => {
      const { client } = stubClient(
        buildResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "I'll check.",
                refusal: null,
                tool_calls: [
                  {
                    id: "tc_1",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":"Paris"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
        } as Partial<ChatCompletion>),
      );
      const adapter = new OpenAIAdapter({ client });

      const result = await adapter.complete({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "weather?" }],
      });

      expect(result.id).toBe("chatcmpl_001");
      expect(result.stopReason).toBe("tool_use");
      expect(result.text).toBe("I'll check.");
      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toEqual({
        type: "tool_use",
        id: "tc_1",
        name: "get_weather",
        input: { city: "Paris" },
      });
      expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
      // AI-R1: the full provider response + usage ride along on `raw`.
      expect(result.usage.raw).toBeDefined();
      expect(result.raw).toBeDefined();
    });

    it("normalizes finish_reason: stop → end_turn, length → max_tokens, content_filter → content_filter", async () => {
      const cases: Array<{
        finish: ChatCompletion.Choice["finish_reason"];
        expected: string;
      }> = [
        { finish: "stop", expected: "end_turn" },
        { finish: "length", expected: "max_tokens" },
        { finish: "content_filter", expected: "content_filter" },
        { finish: "tool_calls", expected: "tool_use" },
      ];
      for (const c of cases) {
        const { client } = stubClient(
          buildResponse({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "x", refusal: null },
                finish_reason: c.finish,
                logprobs: null,
              },
            ],
          } as Partial<ChatCompletion>),
        );
        const adapter = new OpenAIAdapter({ client });
        const result = await adapter.complete({
          model: "gpt-4.1",
          messages: [{ role: "user", content: "x" }],
        });
        expect(result.stopReason).toBe(c.expected);
      }
    });

    it("recovers from invalid JSON in tool_call arguments via __ship_api_raw sentinel", async () => {
      const { client } = stubClient(
        buildResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                refusal: null,
                tool_calls: [
                  {
                    id: "tc_x",
                    type: "function",
                    function: {
                      name: "broken",
                      arguments: '{"trunc',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
              logprobs: null,
            },
          ],
        } as Partial<ChatCompletion>),
      );
      const adapter = new OpenAIAdapter({ client });
      const result = await adapter.complete({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "x" }],
      });
      expect(result.content[0]).toMatchObject({
        type: "tool_use",
        input: { __ship_api_raw: '{"trunc' },
      });
    });

    it("forwards AbortSignal + providerOptions + sets stream:true on streaming requests", async () => {
      const { client, spy } = stubClient(buildResponse());
      const adapter = new OpenAIAdapter({ client });
      const ac = new AbortController();
      await adapter.complete({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "x" }],
        signal: ac.signal,
        providerOptions: { top_p: 0.8 },
      });
      expect(spy.mock.calls[0][1]).toEqual({ signal: ac.signal });
      const body = spy.mock.calls[0][0] as ChatCompletionCreateParamsBase & {
        top_p?: number;
        stream?: boolean;
      };
      expect(body.top_p).toBe(0.8);
      expect(body.stream).toBeFalsy();
    });
  });

  describe("streamComplete", () => {
    it("normalizes a text-only stream into start → text_delta → stop", async () => {
      const events: ChatCompletionChunk[] = [
        {
          id: "stream_1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "hel" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "stream_1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
        },
        {
          id: "stream_1",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
          },
        },
      ] as ChatCompletionChunk[];

      const stream = (async function* () {
        for (const e of events) yield e;
      })();
      const { client } = stubClient(stream);
      const adapter = new OpenAIAdapter({ client });

      const out: StreamEvent[] = [];
      for await (const ev of adapter.streamComplete({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "say hi" }],
      })) {
        out.push(ev);
      }

      expect(out.map((e) => e.type)).toEqual(["start", "text_delta", "text_delta", "stop"]);
      const stop = out[3] as Extract<StreamEvent, { type: "stop" }>;
      expect(stop.stopReason).toBe("end_turn");
      expect(stop.usage).toEqual({ inputTokens: 8, outputTokens: 4 });
    });

    it("normalizes a tool-call stream: start → tool_use_start → tool_input_delta+ → tool_use_end → stop", async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: "stream_2",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "tc_77",
                    type: "function",
                    function: { name: "get_weather", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "stream_2",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"city":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "stream_2",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '"Paris"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "stream_2",
          object: "chat.completion.chunk",
          created: 1700000000,
          model: "gpt-4.1",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        },
      ] as ChatCompletionChunk[];

      const stream = (async function* () {
        for (const c of chunks) yield c;
      })();
      const { client } = stubClient(stream);
      const adapter = new OpenAIAdapter({ client });

      const out: StreamEvent[] = [];
      for await (const ev of adapter.streamComplete({
        model: "gpt-4.1",
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
      expect(end.id).toBe("tc_77");
      expect(end.input).toEqual({ city: "Paris" });
      const stop = out[5] as Extract<StreamEvent, { type: "stop" }>;
      expect(stop.stopReason).toBe("tool_use");
    });

    it("sets stream:true and stream_options.include_usage on streaming requests", async () => {
      const stream = (async function* () {
        yield {
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-4.1",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        } as ChatCompletionChunk;
      })();
      const { client, spy } = stubClient(stream);
      const adapter = new OpenAIAdapter({ client });
      for await (const _ of adapter.streamComplete({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "x" }],
      }))
        void _;

      const body = spy.mock.calls[0][0] as ChatCompletionCreateParamsBase & {
        stream?: boolean;
        stream_options?: { include_usage?: boolean };
      };
      expect(body.stream).toBe(true);
      expect(body.stream_options?.include_usage).toBe(true);
    });
  });
});
