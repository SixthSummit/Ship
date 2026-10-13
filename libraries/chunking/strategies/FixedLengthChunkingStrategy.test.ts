import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedLengthChunkingStrategy } from "./FixedLengthChunkingStrategy.js";

describe("FixedLengthChunkingStrategy", () => {
  let strategy: FixedLengthChunkingStrategy;

  afterEach(() => {
    strategy?.dispose();
  });

  describe("Basic functionality", () => {
    beforeEach(() => {
      strategy = new FixedLengthChunkingStrategy({
        maxTokens: 50,
      });
    });

    it("should chunk text into fixed-length chunks", async () => {
      const text =
        "This is the first sentence. This is the second sentence. This is the third sentence. " +
        "This is a new paragraph with more content. It has multiple sentences too. " +
        "And here is another paragraph. It continues the document. We need enough text for testing. " +
        "This will help us test the chunking properly. More sentences are needed for comprehensive testing. " +
        "Final paragraph to ensure we have enough content. This should be sufficient for our tests.";

      const chunks = await strategy.chunk(text);

      expect(chunks).toBeDefined();
      expect(chunks.length).toBeGreaterThan(1);

      chunks.forEach((chunk, index) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(50);
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.content).toBeTruthy();
        expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
        expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
      });
    });

    it("should handle text shorter than maxTokens", async () => {
      const text = "Short text.";
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(text);
      expect(chunks[0].tokenCount).toBeLessThan(50);
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[0].startIndex).toBe(0);
    });

    it("should handle single-token text", async () => {
      const chunks = await strategy.chunk("Hello");

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe("Hello");
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
      expect(chunks[0].chunkIndex).toBe(0);
    });

    it("should create sequential chunks with non-overlapping indices", async () => {
      const text = "Word ".repeat(200);
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(1);

      for (let i = 0; i < chunks.length - 1; i++) {
        expect(chunks[i + 1].startIndex).toBeGreaterThanOrEqual(chunks[i].endIndex);
      }
    });

    it("should cover the entire document", async () => {
      const text =
        "The quick brown fox jumps over the lazy dog. " +
        "Pack my box with five dozen liquor jugs. " +
        "How vexingly quick daft zebras jump.";
      const chunks = await strategy.chunk(text);

      expect(chunks[0].startIndex).toBe(0);

      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.endIndex).toBeLessThanOrEqual(text.length + 1);
    });

    it("should produce chunks whose token counts sum to total tokens", async () => {
      const text = "Testing token counts across all chunks for accuracy and completeness.";
      const chunks = await strategy.chunk(text);

      const totalTokens = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
      expect(totalTokens).toBeGreaterThan(0);

      // Single chunk for short text
      expect(chunks.length).toBe(1);
      expect(chunks[0].tokenCount).toBe(totalTokens);
    });
  });

  describe("Empty and whitespace handling", () => {
    beforeEach(() => {
      strategy = new FixedLengthChunkingStrategy({
        maxTokens: 50,
      });
    });

    it("should return chunks for whitespace-only text", async () => {
      const chunks = await strategy.chunk("   \n\n\t  ");
      // FixedLength strategy tokenizes everything; whitespace may produce tokens
      expect(Array.isArray(chunks)).toBe(true);
    });

    it("should handle text with many newlines", async () => {
      const text = "Line one.\n\n\nLine two.\n\n\nLine three.";
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      const combined = chunks.map((c) => c.content).join("");
      expect(combined).toContain("Line one");
      expect(combined).toContain("Line three");
    });
  });

  describe("Token encoding", () => {
    it("should use default cl100k_base encoding", () => {
      const s = new FixedLengthChunkingStrategy({ maxTokens: 100 });
      expect(s).toBeDefined();
      s.dispose();
    });

    it("should accept explicit encoding", async () => {
      const s = new FixedLengthChunkingStrategy({
        maxTokens: 50,
        encoding: "cl100k_base",
      });

      const chunks = await s.chunk("Test with explicit encoding.");
      expect(chunks.length).toBe(1);
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
      s.dispose();
    });

    it("should fall back gracefully for invalid encoding", async () => {
      const s = new FixedLengthChunkingStrategy({
        maxTokens: 50,
        encoding: "invalid_encoding_name",
      });

      const chunks = await s.chunk("Test with fallback encoding.");
      expect(chunks.length).toBe(1);
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
      s.dispose();
    });

    it("should accept p50k_base encoding", async () => {
      const s = new FixedLengthChunkingStrategy({
        maxTokens: 50,
        encoding: "p50k_base",
      });

      const chunks = await s.chunk("Test with p50k_base encoding.");
      expect(chunks.length).toBe(1);
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
      s.dispose();
    });
  });

  describe("Large documents", () => {
    beforeEach(() => {
      strategy = new FixedLengthChunkingStrategy({
        maxTokens: 100,
      });
    });

    it("should handle large documents efficiently", async () => {
      const largeText = "This is a sentence with several words. ".repeat(500);

      const startTime = Date.now();
      const chunks = await strategy.chunk(largeText);
      const elapsed = Date.now() - startTime;

      expect(chunks.length).toBeGreaterThan(10);
      expect(elapsed).toBeLessThan(5000);

      chunks.forEach((chunk) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(100);
        expect(chunk.tokenCount).toBeGreaterThan(0);
      });
    });

    it("should produce consistent results for the same input", async () => {
      const text = "Deterministic chunking test. Same input produces same output.";

      const chunks1 = await strategy.chunk(text);
      const chunks2 = await strategy.chunk(text);

      expect(chunks1.length).toBe(chunks2.length);
      for (let i = 0; i < chunks1.length; i++) {
        expect(chunks1[i].content).toBe(chunks2[i].content);
        expect(chunks1[i].tokenCount).toBe(chunks2[i].tokenCount);
        expect(chunks1[i].startIndex).toBe(chunks2[i].startIndex);
        expect(chunks1[i].endIndex).toBe(chunks2[i].endIndex);
      }
    });
  });

  describe("Special content", () => {
    beforeEach(() => {
      strategy = new FixedLengthChunkingStrategy({
        maxTokens: 50,
      });
    });

    it("should handle unicode characters", async () => {
      const text = "Unicode: café, naïve, 你好世界, emoji 😀🎉. More text here.";
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      const combined = chunks.map((c) => c.content).join("");
      expect(combined).toContain("café");
      expect(combined).toContain("你好");
    });

    it("should handle code content", async () => {
      const text = `
function hello() {
  console.log("Hello, world!");
  return { status: 200, message: "OK" };
}

const result = hello();
console.log(result.status);
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      const combined = chunks.map((c) => c.content).join("");
      expect(combined).toContain("function hello");
    });

    it("should handle markdown content", async () => {
      const text = `
# Header

Some **bold** and *italic* text.

- List item 1
- List item 2

> A blockquote
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      const combined = chunks.map((c) => c.content).join("");
      expect(combined).toContain("# Header");
    });
  });

  describe("Different maxTokens configurations", () => {
    it("should create more chunks with smaller maxTokens", async () => {
      const text = "Word ".repeat(100);

      const smallChunks = new FixedLengthChunkingStrategy({ maxTokens: 20 });
      const largeChunks = new FixedLengthChunkingStrategy({ maxTokens: 100 });

      const small = await smallChunks.chunk(text);
      const large = await largeChunks.chunk(text);

      expect(small.length).toBeGreaterThan(large.length);

      smallChunks.dispose();
      largeChunks.dispose();
    });

    it("should handle maxTokens of 1", async () => {
      const s = new FixedLengthChunkingStrategy({ maxTokens: 1 });
      const text = "Hello world";
      const chunks = await s.chunk(text);

      // Each token should be its own chunk
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.tokenCount).toBe(1);
      });

      s.dispose();
    });
  });

  describe("Resource cleanup", () => {
    it("should not throw when dispose is called multiple times", () => {
      const s = new FixedLengthChunkingStrategy({ maxTokens: 50 });
      expect(() => {
        s.dispose();
        s.dispose();
      }).not.toThrow();
    });
  });
});
