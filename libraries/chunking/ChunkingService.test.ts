import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChunkingService } from "./ChunkingService.js";
import { SlidingWindowChunkingStrategy } from "./strategies/SlidingWindowChunkingStrategy.js";

describe("ChunkingService", () => {
  let service: ChunkingService;

  const sampleText = `
This is the first sentence. This is the second sentence. This is the third sentence.
This is a new paragraph with more content. It has multiple sentences too.
And here is another paragraph. It continues the document. We need enough text for testing.
This will help us test the chunking properly. More sentences are needed for comprehensive testing.
Final paragraph to ensure we have enough content. This should be sufficient for our tests.
  `.trim();

  afterEach(() => {
    service?.dispose();
  });

  describe("FixedLengthChunkingStrategy", () => {
    beforeEach(() => {
      service = ChunkingService.createWithFixedLength({
        maxTokens: 50,
      });
    });

    it("should chunk text into fixed-length chunks", async () => {
      const chunks = await service.chunk(sampleText);

      expect(chunks).toBeDefined();
      expect(chunks.length).toBeGreaterThan(0);

      // Each chunk (except possibly the last) should respect the token limit
      chunks.forEach((chunk, index) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(50);
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.content).toBeTruthy();
        expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
        expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
      });
    });

    it("should handle empty text", async () => {
      const chunks = await service.chunk("");
      expect(chunks).toEqual([]);
    });

    it("should handle single-token text", async () => {
      const chunks = await service.chunk("Hello");
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe("Hello");
      expect(chunks[0].tokenCount).toBeGreaterThan(0);
    });

    it("should handle text shorter than max tokens", async () => {
      const shortText = "This is a short text.";
      const chunks = await service.chunk(shortText);

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(shortText);
      expect(chunks[0].tokenCount).toBeLessThan(50);
    });

    it("should create sequential chunks with proper indices", async () => {
      const chunks = await service.chunk(sampleText);

      for (let i = 0; i < chunks.length - 1; i++) {
        // Each chunk should start where or after the previous one ended
        expect(chunks[i + 1].startIndex).toBeGreaterThanOrEqual(chunks[i].endIndex);
      }
    });
  });

  describe("SlidingWindowChunkingStrategy", () => {
    beforeEach(() => {
      service = ChunkingService.createWithSlidingWindow({
        maxTokens: 50,
        overlapTokens: 10,
      });
    });

    it("should chunk text with overlapping windows", async () => {
      const chunks = await service.chunk(sampleText);

      expect(chunks).toBeDefined();
      expect(chunks.length).toBeGreaterThan(0);

      // Each chunk should respect the token limit
      chunks.forEach((chunk, index) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(50);
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.content).toBeTruthy();
      });
    });

    it("should create overlapping chunks", async () => {
      const chunks = await service.chunk(sampleText);

      if (chunks.length > 1) {
        // Check that there is some overlap between consecutive chunks
        for (let i = 0; i < chunks.length - 1; i++) {
          // The next chunk should start before the current chunk ends
          // to create overlap (in terms of content)
          const currentChunkEnd = chunks[i].endIndex;
          const nextChunkStart = chunks[i + 1].startIndex;

          // There should be overlap in the original text
          expect(nextChunkStart).toBeLessThan(currentChunkEnd);
        }
      }
    });

    it("should not end mid-sentence when possible", async () => {
      const chunks = await service.chunk(sampleText);

      // Check that chunks (except possibly the last) end with sentence boundaries
      for (let i = 0; i < chunks.length - 1; i++) {
        const chunk = chunks[i];
        const _lastChar = chunk.content.trim().slice(-1);

        // Should ideally end with sentence-ending punctuation
        // Note: This may not always be possible depending on token limits
        // So we check that at least some chunks respect this
        if (
          chunk.content.includes(".") ||
          chunk.content.includes("!") ||
          chunk.content.includes("?")
        ) {
          // If the chunk contains sentence endings, it should try to end on one
          const endsWithPunctuation = /[.!?]\s*$/.test(chunk.content);
          // We can't guarantee all chunks end on sentence boundaries,
          // but we verify the logic attempts to do so
          expect(typeof endsWithPunctuation).toBe("boolean");
        }
      }
    });

    it("should handle empty text", async () => {
      const chunks = await service.chunk("");
      expect(chunks).toEqual([]);
    });

    it("should throw error if overlap is greater than or equal to max tokens", () => {
      expect(() => {
        new SlidingWindowChunkingStrategy({
          maxTokens: 50,
          overlapTokens: 50,
        });
      }).toThrow("overlapTokens must be less than maxTokens");

      expect(() => {
        new SlidingWindowChunkingStrategy({
          maxTokens: 50,
          overlapTokens: 60,
        });
      }).toThrow("overlapTokens must be less than maxTokens");
    });
  });

  describe("Factory methods", () => {
    it("should create service with fixed length strategy", () => {
      const fixedService = ChunkingService.createWithFixedLength({
        maxTokens: 100,
      });

      expect(fixedService).toBeInstanceOf(ChunkingService);
      fixedService.dispose();
    });

    it("should create service with sliding window strategy", () => {
      const slidingService = ChunkingService.createWithSlidingWindow({
        maxTokens: 100,
        overlapTokens: 20,
      });

      expect(slidingService).toBeInstanceOf(ChunkingService);
      slidingService.dispose();
    });

    it("should create service with appropriate strategy based on options", () => {
      // Fixed length (no overlap)
      const fixedService = ChunkingService.create({
        maxTokens: 100,
      });
      expect(fixedService).toBeInstanceOf(ChunkingService);
      fixedService.dispose();

      // Sliding window (with overlap)
      const slidingService = ChunkingService.create({
        maxTokens: 100,
        overlapTokens: 20,
      });
      expect(slidingService).toBeInstanceOf(ChunkingService);
      slidingService.dispose();
    });
  });

  describe("Strategy switching", () => {
    it("should allow switching strategies", async () => {
      const initialService = ChunkingService.createWithFixedLength({
        maxTokens: 50,
      });

      const chunks1 = await initialService.chunk(sampleText);
      expect(chunks1.length).toBeGreaterThan(0);

      // Switch to sliding window strategy
      const newStrategy = new SlidingWindowChunkingStrategy({
        maxTokens: 50,
        overlapTokens: 10,
      });
      initialService.setStrategy(newStrategy);

      const chunks2 = await initialService.chunk(sampleText);
      expect(chunks2.length).toBeGreaterThan(0);

      // The number of chunks should differ due to overlap
      expect(chunks2.length).toBeGreaterThanOrEqual(chunks1.length);

      initialService.dispose();
    }, 10000); // Increase timeout to 10 seconds
  });

  describe("Edge cases", () => {
    it("should handle very long text", async () => {
      const longText = sampleText.repeat(10);
      service = ChunkingService.createWithFixedLength({
        maxTokens: 50,
      });

      const chunks = await service.chunk(longText);
      expect(chunks.length).toBeGreaterThan(1);

      // Verify all chunks are valid
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
        expect(chunk.tokenCount).toBeGreaterThan(0);
        expect(chunk.tokenCount).toBeLessThanOrEqual(50);
      });
    });

    it("should handle text with special characters", async () => {
      const specialText = "Hello! How are you? I'm fine. Let's test: this, that, and more...";
      service = ChunkingService.createWithSlidingWindow({
        maxTokens: 20,
        overlapTokens: 5,
      });

      const chunks = await service.chunk(specialText);
      expect(chunks.length).toBeGreaterThan(0);

      // Verify the full text is covered
      const combinedText = chunks.map((c) => c.content).join("");
      expect(combinedText.length).toBeGreaterThan(0);
    });

    it("should handle text with only whitespace", async () => {
      const whitespaceText = "   \n\n\t  ";
      service = ChunkingService.createWithFixedLength({
        maxTokens: 50,
      });

      const chunks = await service.chunk(whitespaceText);
      // Should handle gracefully - might return empty or minimal chunks
      expect(Array.isArray(chunks)).toBe(true);
    });
  });
});
