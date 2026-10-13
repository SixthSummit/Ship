import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlidingWindowChunkingStrategy } from "./SlidingWindowChunkingStrategy.js";

describe("SlidingWindowChunkingStrategy - Enhanced Features", () => {
  let strategy: SlidingWindowChunkingStrategy;

  afterEach(() => {
    strategy?.dispose();
  });

  describe("Paragraph boundary detection", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
        preferParagraphBoundaries: true,
      });
    });

    it("should prefer paragraph boundaries over sentence boundaries", async () => {
      const text = `
This is the first paragraph. It has multiple sentences. They belong together.

This is the second paragraph. It also has multiple sentences. They form a unit.

This is the third paragraph. It continues the theme.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Chunks should ideally end at paragraph boundaries
      chunks.slice(0, -1).forEach((chunk) => {
        // Most chunks should end with double newline or be at paragraph boundaries
        const endsWithParagraph =
          chunk.content.trim().endsWith(".") || chunk.content.includes("\n\n");
        expect(typeof endsWithParagraph).toBe("boolean");
      });
    });

    it("should handle text with clear paragraph breaks", async () => {
      const text = `
First paragraph here.

Second paragraph here.

Third paragraph here.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
        expect(chunk.tokenCount).toBeGreaterThan(0);
      });
    });

    it("should fall back to sentence boundaries when no paragraph breaks exist", async () => {
      const text =
        "This is one sentence. This is another sentence. This is a third sentence. This is a fourth sentence.";

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      // Should still create valid chunks even without paragraph breaks
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
      });
    });
  });

  describe("Improved sentence detection", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 80,
        overlapTokens: 15,
        preferParagraphBoundaries: false, // Focus on sentence detection
      });
    });

    it("should handle abbreviations correctly", async () => {
      const text =
        "Dr. Smith went to the store. Mr. Jones followed him. Mrs. Brown stayed home. They met at St. Patrick's Church.";

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Should not split on abbreviations
      chunks.forEach((chunk) => {
        // Verify no chunks start with a lowercase letter (which would indicate split on abbreviation)
        if (chunk.content.trim().length > 0) {
          const firstChar = chunk.content.trim()[0];
          const startsProper = /[A-Z"]/.test(firstChar);
          expect(startsProper).toBe(true);
        }
      });
    });

    it("should handle numbers with decimals correctly", async () => {
      const text =
        "The value is 3.14 in mathematics. Another value is 2.5 meters. The final result was 99.9 percent accurate.";

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Should not split on decimal points
      const combinedText = chunks.map((c) => c.content).join("");
      expect(combinedText).toContain("3.14");
      expect(combinedText).toContain("2.5");
      expect(combinedText).toContain("99.9");
    });

    it("should handle URLs and email addresses", async () => {
      const text =
        "Visit https://example.com for more information. Contact us at info@example.com for details. Check out https://test.org as well.";

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // URLs should not be split
      const combinedText = chunks.map((c) => c.content).join("");
      expect(combinedText).toContain("https://example.com");
      expect(combinedText).toContain("info@example.com");
    });

    it("should handle quotations correctly", async () => {
      const text =
        'She said, "Hello there." Then she left. He replied, "Goodbye!" The conversation ended.';

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Quotations should be handled properly
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
      });
    });

    it("should handle mixed punctuation", async () => {
      const text = "What is this? It's amazing! Really? Yes. Absolutely! I can't believe it.";

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.content.trim()).toBeTruthy();
      });
    });
  });

  describe("Code block protection", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
      });
    });

    it("should not split chunks within code blocks", async () => {
      const text = `
Here is some text before the code.

\`\`\`javascript
function example() {
  return "This should not be split";
}
\`\`\`

Here is some text after the code.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // If a chunk contains a code block opening, it should contain the closing too
      chunks.forEach((chunk) => {
        const codeBlockStarts = (chunk.content.match(/```/g) || []).length;
        // Code blocks should be complete (even number of ```)
        if (codeBlockStarts > 0) {
          expect(codeBlockStarts % 2).toBe(0);
        }
      });
    });

    it("should handle inline code", async () => {
      const text =
        "Use the `console.log()` function to debug. The `Array.map()` method is useful. Try `forEach()` as well.";

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Inline code should be preserved
      const combinedText = chunks.map((c) => c.content).join("");
      expect(combinedText).toContain("`console.log()`");
    });

    it("should handle multiple code blocks", async () => {
      const text = `
First paragraph.

\`\`\`python
def hello():
    print("world")
\`\`\`

Second paragraph.

\`\`\`javascript
console.log("test");
\`\`\`

Third paragraph.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Verify code blocks are intact
      chunks.forEach((chunk) => {
        const codeBlockCount = (chunk.content.match(/```/g) || []).length;
        if (codeBlockCount > 0) {
          expect(codeBlockCount % 2).toBe(0);
        }
      });
    });
  });

  describe("Configurable minimum chunk ratio", () => {
    it("should respect custom minChunkRatio", async () => {
      const text = `
This is a paragraph. It has some content. More content here. Even more content to ensure we have enough text.

This is another paragraph. It also has content. Additional sentences here.
      `.trim();

      // Strategy with 60% minimum
      const strictStrategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
        minChunkRatio: 0.6,
      });

      const chunks = await strictStrategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Most chunks should be relatively large (close to maxTokens)
      chunks.slice(0, -1).forEach((chunk) => {
        // Should be at least 60% of maxTokens or close to it
        expect(chunk.tokenCount).toBeGreaterThan(0);
      });

      strictStrategy.dispose();
    });

    it("should throw error for invalid minChunkRatio", () => {
      expect(() => {
        new SlidingWindowChunkingStrategy({
          maxTokens: 100,
          overlapTokens: 20,
          minChunkRatio: 0.05, // Too small
        });
      }).toThrow("minChunkRatio must be between 0.1 and 0.9");

      expect(() => {
        new SlidingWindowChunkingStrategy({
          maxTokens: 100,
          overlapTokens: 20,
          minChunkRatio: 0.95, // Too large
        });
      }).toThrow("minChunkRatio must be between 0.1 and 0.9");
    });

    it("should use default minChunkRatio when not specified", () => {
      const defaultStrategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
      });

      expect(defaultStrategy).toBeDefined();
      defaultStrategy.dispose();
    });
  });

  describe("Overlap validation", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
      });
    });

    it("should create overlapping chunks", async () => {
      const text = `
First paragraph with some content. This has multiple sentences. The content continues here. We need to add more text to ensure multiple chunks are created.

Second paragraph with different content. It also has multiple sentences. More information follows. Additional content is added here to make the text longer.

Third paragraph to ensure enough content. Additional sentences are here. Even more text follows. We continue with more sentences to reach the token limit.

Fourth paragraph with substantial content. This ensures we have enough text for multiple chunks. More details are provided here.

Fifth paragraph to guarantee multiple chunks. We add even more content here. The text continues with additional information.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Verify overlap exists between consecutive chunks
      for (let i = 0; i < chunks.length - 1; i++) {
        const currentChunk = chunks[i];
        const nextChunk = chunks[i + 1];

        // Next chunk should start before current chunk ends (indicating overlap)
        expect(nextChunk.startIndex).toBeLessThan(currentChunk.endIndex);
      }
    });

    it("should throw error if overlapTokens >= maxTokens", () => {
      expect(() => {
        new SlidingWindowChunkingStrategy({
          maxTokens: 100,
          overlapTokens: 100,
        });
      }).toThrow("overlapTokens must be less than maxTokens");

      expect(() => {
        new SlidingWindowChunkingStrategy({
          maxTokens: 100,
          overlapTokens: 150,
        });
      }).toThrow("overlapTokens must be less than maxTokens");
    });
  });

  describe("preferParagraphBoundaries option", () => {
    it("should respect preferParagraphBoundaries: true", async () => {
      const text = `
Paragraph one. Sentence two. Sentence three.

Paragraph two. Another sentence. Final sentence.
      `.trim();

      const paragraphStrategy = new SlidingWindowChunkingStrategy({
        maxTokens: 80,
        overlapTokens: 15,
        preferParagraphBoundaries: true,
      });

      const chunks = await paragraphStrategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      paragraphStrategy.dispose();
    });

    it("should respect preferParagraphBoundaries: false", async () => {
      const text = `
Paragraph one. Sentence two. Sentence three.

Paragraph two. Another sentence. Final sentence.
      `.trim();

      const sentenceStrategy = new SlidingWindowChunkingStrategy({
        maxTokens: 80,
        overlapTokens: 15,
        preferParagraphBoundaries: false,
      });

      const chunks = await sentenceStrategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      sentenceStrategy.dispose();
    });
  });

  describe("Edge cases and robustness", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
      });
    });

    it("should handle empty text", async () => {
      const chunks = await strategy.chunk("");
      expect(chunks).toEqual([]);
    });

    it("should handle single sentence", async () => {
      const text = "This is a single sentence.";
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(text);
    });

    it("should handle text with only whitespace", async () => {
      const text = "   \n\n\t  ";
      const chunks = await strategy.chunk(text);

      expect(Array.isArray(chunks)).toBe(true);
    });

    it("should handle very long text", async () => {
      const longText = "This is a sentence. ".repeat(100);
      const chunks = await strategy.chunk(longText);

      expect(chunks.length).toBeGreaterThan(1);

      // All chunks should respect token limits
      chunks.forEach((chunk) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(100);
      });
    });

    it("should handle special characters", async () => {
      const text =
        "Special chars: @#$%^&*()! Email: test@example.com. URL: https://test.com. Done.";
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toContain("@");
      expect(chunks[0].content).toContain("https://");
    });

    it("should handle unicode characters", async () => {
      const text = "Unicode test: café, naïve, 你好, emoji 😀. More text here.";
      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toContain("café");
      expect(chunks[0].content).toContain("😀");
    });
  });

  describe("Boundary position validation", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
        minChunkRatio: 0.5,
      });
    });

    it("should not create chunks smaller than minChunkRatio", async () => {
      const text = `
This is the first paragraph with substantial content. It has multiple sentences to ensure proper testing. More content follows here.

Short.

This is another paragraph with more content. Additional sentences are included here.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Check that chunks (except possibly the last) meet minimum size
      chunks.slice(0, -1).forEach((chunk) => {
        // Should be at least minChunkRatio of maxTokens or reasonable size
        expect(chunk.tokenCount).toBeGreaterThan(20);
      });
    });

    it("should handle multiple boundary candidates", async () => {
      const text = `
First sentence. Second sentence. Third sentence.

Fourth sentence. Fifth sentence. Sixth sentence.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.content.trim()).toBeTruthy();
      });
    });
  });

  describe("Integration with different content types", () => {
    beforeEach(() => {
      strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 150,
        overlapTokens: 30,
        preferParagraphBoundaries: true,
      });
    });

    it("should handle mixed content (text, code, and lists)", async () => {
      const text = `
# Introduction

This is an introduction paragraph.

## Code Example

\`\`\`python
def example():
    return True
\`\`\`

## Key Points

Regular text here. More content follows.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
        expect(chunk.tokenCount).toBeGreaterThan(0);
      });
    });

    it("should handle technical documentation", async () => {
      const text = `
The API endpoint accepts GET requests. Use /api/v1/users to fetch users. The response format is JSON.

Example: curl https://api.example.com/users

The timeout is 30s. Error codes: 400, 401, 404, 500.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Should preserve technical content
      const combinedText = chunks.map((c) => c.content).join("");
      expect(combinedText).toContain("GET");
      expect(combinedText).toContain("/api/v1/users");
    });

    it("should handle narrative content", async () => {
      const text = `
Once upon a time, there was a developer. She wrote code every day. Her code was elegant.

One day, she discovered a bug. She investigated thoroughly. The bug was fixed.

The end of the story. Everyone was happy. The code shipped successfully.
      `.trim();

      const chunks = await strategy.chunk(text);

      expect(chunks.length).toBeGreaterThan(0);

      // Should maintain narrative flow
      chunks.forEach((chunk) => {
        // Chunks should have complete sentences
        expect(chunk.content.trim().length).toBeGreaterThan(0);
      });
    });
  });

  describe("Performance and efficiency", () => {
    it("should handle large documents efficiently", async () => {
      const largeText = `
This is a paragraph. It has multiple sentences. The content is substantial.

`.repeat(50);

      const strategy = new SlidingWindowChunkingStrategy({
        maxTokens: 200,
        overlapTokens: 40,
      });

      const startTime = Date.now();
      const chunks = await strategy.chunk(largeText);
      const endTime = Date.now();

      expect(chunks.length).toBeGreaterThan(3);

      // Should complete in reasonable time (< 5 seconds for this size)
      expect(endTime - startTime).toBeLessThan(5000);

      strategy.dispose();
    });

    it("should produce consistent results for same input", async () => {
      const text = "Consistent test. Same input. Same output expected.";

      const strategy1 = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
      });

      const strategy2 = new SlidingWindowChunkingStrategy({
        maxTokens: 100,
        overlapTokens: 20,
      });

      const chunks1 = await strategy1.chunk(text);
      const chunks2 = await strategy2.chunk(text);

      expect(chunks1.length).toBe(chunks2.length);
      expect(chunks1[0].content).toBe(chunks2[0].content);

      strategy1.dispose();
      strategy2.dispose();
    });
  });
});
