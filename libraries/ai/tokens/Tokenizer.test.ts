import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  countMessageTokens,
  estimateMessageTokens,
  estimateTokens,
  HeuristicTokenizer,
  type Tokenizer,
} from "./Tokenizer.js";

describe("HeuristicTokenizer", () => {
  it("counts ~chars/4 by default", () => {
    const tk = new HeuristicTokenizer();
    expect(tk.count("")).toBe(0);
    expect(tk.count("hi")).toBe(1);
    expect(tk.count("hello")).toBe(2); // ceil(5/4)
    expect(tk.count("a".repeat(40))).toBe(10);
  });

  it("respects custom charsPerToken", () => {
    const tk = new HeuristicTokenizer({ charsPerToken: 2 });
    expect(tk.count("hello")).toBe(3); // ceil(5/2)
  });

  it("surfaces the model identifier", () => {
    const tk = new HeuristicTokenizer({ model: "estimator-en" });
    expect(tk.model).toBe("estimator-en");
  });
});

class StubTokenizer implements Tokenizer {
  readonly model = "stub";
  // Each character = 1 token — makes assertions trivial to write.
  count(text: string): number {
    return text.length;
  }
}

describe("countMessageTokens", () => {
  it("sums text content + per-message overhead", () => {
    const tk = new StubTokenizer();
    const messages: Message[] = [
      { role: "user", content: "hello" }, // 5 + 4 overhead = 9
      { role: "assistant", content: "hi" }, // 2 + 4 overhead = 6
    ];
    expect(countMessageTokens(tk, messages)).toBe(15);
  });

  it("counts content-part text + tool_use name + tool_use input JSON", () => {
    const tk = new StubTokenizer();
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" }, // 2
          {
            type: "tool_use",
            id: "tu",
            name: "get", // 3
            input: { city: "P" }, // JSON.stringify → {"city":"P"} = 12
          },
        ],
      },
    ];
    // 2 + 3 + 12 + 4 (overhead) = 21
    expect(countMessageTokens(tk, messages)).toBe(21);
  });

  it("counts tool_result content", () => {
    const tk = new StubTokenizer();
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu",
            content: "result-data", // 11
          },
        ],
      },
    ];
    expect(countMessageTokens(tk, messages)).toBe(15); // 11 + 4
  });

  it("budgets a fixed token cost per image part (default 1024)", () => {
    const tk = new StubTokenizer();
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "see" }, // 3
          { type: "image", mediaType: "image/png", data: "Zm9v" },
        ],
      },
    ];
    // 3 + 1024 + 4 overhead
    expect(countMessageTokens(tk, messages)).toBe(1031);
  });

  it("respects custom perImageTokens / perMessageOverhead", () => {
    const tk = new StubTokenizer();
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: "x" }],
      },
    ];
    expect(
      countMessageTokens(tk, messages, {
        perImageTokens: 200,
        perMessageOverhead: 1,
      }),
    ).toBe(201);
  });

  it("counts msg.name when present", () => {
    const tk = new StubTokenizer();
    const messages: Message[] = [
      {
        role: "tool",
        name: "weather", // 7
        content: "ok", // 2
      },
    ];
    expect(countMessageTokens(tk, messages)).toBe(13); // 7 + 2 + 4
  });

  it("falls back to a conservative estimate when JSON serialization fails", () => {
    const tk = new StubTokenizer();
    // Circular input — JSON.stringify throws.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu",
            name: "n", // 1
            input: circular,
          },
        ],
      },
    ];
    // 1 (name) + 16 (fallback) + 4 overhead
    expect(countMessageTokens(tk, messages)).toBe(21);
  });
});

describe("estimateTokens / estimateMessageTokens (AI-R3 pre-call estimates)", () => {
  it("estimateTokens is ~chars/4", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2); // ceil(5/4)
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });

  it("estimateMessageTokens sums text + per-message overhead", () => {
    const messages: Message[] = [
      { role: "user", content: "a".repeat(40) }, // 10 + 4 overhead
      { role: "assistant", content: "a".repeat(8) }, // 2 + 4 overhead
    ];
    expect(estimateMessageTokens(messages)).toBe(20);
  });

  it("estimateMessageTokens budgets per-image + counts tool/text parts", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(8) }, // 2
          { type: "image", mediaType: "image/png", data: "x" }, // 1024 default
        ],
      },
    ];
    expect(estimateMessageTokens(messages)).toBe(1030); // 2 + 1024 + 4 overhead
  });
});
