import { describe, expect, it, vi } from "vitest";
import type {
  CompleteOptions,
  CompleteResult,
  EmbedOptions,
  EmbedResult,
  StreamCompleteOptions,
  StreamEvent,
} from "../types.js";
import type { LLMProvider } from "./LLMProvider.js";

describe("LLMProvider interface", () => {
  it("a minimal stub conforms (proves the contract is implementable)", async () => {
    class MockLLM implements LLMProvider {
      readonly name = "mock";

      async complete(opts: CompleteOptions): Promise<CompleteResult> {
        return {
          id: "mock-1",
          model: opts.model,
          content: [{ type: "text", text: "hello" }],
          text: "hello",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }

      async *streamComplete(opts: StreamCompleteOptions): AsyncIterable<StreamEvent> {
        yield { type: "start", id: "mock-1", model: opts.model };
        yield { type: "text_delta", delta: "hello" };
        yield {
          type: "stop",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    }

    const llm: LLMProvider = new MockLLM();
    const result = await llm.complete({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.text).toBe("hello");
    expect(result.stopReason).toBe("end_turn");

    const events: StreamEvent[] = [];
    for await (const event of llm.streamComplete({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "stop"]);
  });

  it("`embed` is optional — providers without embeddings simply omit it", () => {
    class TextOnlyLLM implements LLMProvider {
      readonly name = "text-only";
      async complete(): Promise<CompleteResult> {
        throw new Error("not used");
      }
      async *streamComplete(): AsyncIterable<StreamEvent> {
        // empty
      }
    }
    const llm: LLMProvider = new TextOnlyLLM();
    expect(llm.embed).toBeUndefined();
  });

  it("`embed` is callable when supplied", async () => {
    const embedSpy = vi.fn(
      async (opts: EmbedOptions): Promise<EmbedResult> => ({
        model: opts.model,
        embeddings: opts.inputs.map(() => [0.1, 0.2, 0.3]),
        usage: { inputTokens: opts.inputs.length },
      }),
    );

    class EmbeddingLLM implements LLMProvider {
      readonly name = "embed";
      async complete(): Promise<CompleteResult> {
        throw new Error("not used");
      }
      async *streamComplete(): AsyncIterable<StreamEvent> {
        // empty
      }
      embed = embedSpy;
    }

    const llm: LLMProvider = new EmbeddingLLM();
    const out = await llm.embed!({
      model: "test-embed",
      inputs: ["hello", "world"],
    });
    expect(embedSpy).toHaveBeenCalledOnce();
    expect(out.embeddings).toHaveLength(2);
    expect(out.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
  });

  it("forwards `signal` so adapters can abort in-flight requests", async () => {
    const ac = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    class SignalAwareLLM implements LLMProvider {
      readonly name = "signal-aware";
      async complete(opts: CompleteOptions): Promise<CompleteResult> {
        receivedSignal = opts.signal;
        return {
          id: "x",
          model: opts.model,
          content: [],
          text: "",
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
      async *streamComplete(): AsyncIterable<StreamEvent> {
        // empty
      }
    }

    const llm: LLMProvider = new SignalAwareLLM();
    await llm.complete({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
    });
    expect(receivedSignal).toBe(ac.signal);
  });
});
