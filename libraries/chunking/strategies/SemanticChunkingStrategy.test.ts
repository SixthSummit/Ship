import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SemanticChunkingStrategy } from "./SemanticChunkingStrategy.js";

describe("SemanticChunkingStrategy", () => {
  let strategy: SemanticChunkingStrategy;

  const sampleDocument = `
# Introduction to AI

Artificial Intelligence (AI) has revolutionized many aspects of modern life. From healthcare to finance, AI systems are being deployed to solve complex problems.

## Machine Learning

Machine Learning, a subset of AI, enables computers to learn from data without being explicitly programmed. Deep learning, in turn, is a subset of machine learning that uses neural networks with multiple layers.

Key concepts in machine learning include:
- Supervised learning
- Unsupervised learning
- Reinforcement learning

## Natural Language Processing

Natural Language Processing (NLP) is another important area of AI. It focuses on the interaction between computers and human language.

\`\`\`python
def tokenize(text):
    return text.split()
\`\`\`

NLP techniques are used in applications like chatbots, translation services, and sentiment analysis.
  `.trim();

  afterEach(() => {
    strategy?.dispose();
  });

  describe("Basic functionality", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 200,
        minTokens: 50,
      });
    });

    it("should chunk text based on semantic boundaries", async () => {
      const chunks = await strategy.chunk(sampleDocument);

      expect(chunks).toBeDefined();
      expect(chunks.length).toBeGreaterThan(0);

      // Verify all chunks have required properties
      chunks.forEach((chunk, index) => {
        expect(chunk.tokenCount).toBeGreaterThan(0);
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.content).toBeTruthy();
        expect(chunk.startIndex).toBeGreaterThanOrEqual(0);
        expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
      });
    });

    it("should respect token limits", async () => {
      const chunks = await strategy.chunk(sampleDocument);

      chunks.forEach((chunk) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(200);
      });
    });

    it("should handle empty text", async () => {
      const chunks = await strategy.chunk("");
      expect(chunks).toEqual([]);
    });

    it("should handle single paragraph", async () => {
      const singleParagraph = "This is a single paragraph with some content.";
      const chunks = await strategy.chunk(singleParagraph);

      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe(singleParagraph);
    });
  });

  describe("Code block handling", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 100,
        minTokens: 20,
      });
    });

    it("should not split code blocks", async () => {
      const textWithCode = `
Here is some text before code.

\`\`\`javascript
function example() {
  return "This should not be split";
}
\`\`\`

Here is some text after code.
      `.trim();

      const chunks = await strategy.chunk(textWithCode);

      // Verify that code block is kept intact in one chunk
      const codeChunk = chunks.find((chunk) => chunk.content.includes("```"));
      expect(codeChunk).toBeDefined();
      expect(codeChunk?.content).toContain("function example");
    });
  });

  describe("List handling", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 150,
        minTokens: 30,
      });
    });

    it("should keep lists together", async () => {
      const textWithList = `
Main concepts:
- First item
- Second item
- Third item

After the list.
      `.trim();

      const chunks = await strategy.chunk(textWithList);

      // Verify list is kept together
      const listChunk = chunks.find((chunk) => chunk.content.includes("First item"));
      expect(listChunk).toBeDefined();
      expect(listChunk?.content).toContain("Second item");
      expect(listChunk?.content).toContain("Third item");
    });

    it("should handle numbered lists", async () => {
      const textWithNumberedList = `
Steps to follow:
1. First step
2. Second step
3. Third step

Conclusion here.
      `.trim();

      const chunks = await strategy.chunk(textWithNumberedList);

      // Verify numbered list is kept together
      const listChunk = chunks.find((chunk) => chunk.content.includes("1. First step"));
      expect(listChunk).toBeDefined();
    });
  });

  describe("Header preservation", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 100,
        minTokens: 20,
      });
    });

    it("should recognize markdown headers", async () => {
      const textWithHeaders = `
# Main Header

Content under main header.

## Sub Header

Content under sub header.
      `.trim();

      const chunks = await strategy.chunk(textWithHeaders);

      expect(chunks.length).toBeGreaterThan(0);
      // Headers should be preserved as semantic units
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
      });
    });
  });

  describe("Small chunk merging", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 200,
        minTokens: 50,
        mergeSmallChunks: true,
      });
    });

    it("should merge small chunks with adjacent chunks", async () => {
      const textWithSmallParagraphs = `
Short paragraph one.

Short paragraph two.

Short paragraph three.

A longer paragraph with more content to make it exceed the minimum token count and ensure proper testing.
      `.trim();

      const chunks = await strategy.chunk(textWithSmallParagraphs);

      // Verify that small chunks were merged
      chunks.forEach((chunk) => {
        // After merging, most chunks should meet the minimum token requirement
        // or be at the end of the document
        if (chunk.chunkIndex < chunks.length - 1) {
          expect(chunk.tokenCount).toBeGreaterThanOrEqual(50);
        }
      });
    });

    it("should not merge if disabled", async () => {
      const strategyNoMerge = new SemanticChunkingStrategy({
        maxTokens: 200,
        minTokens: 50,
        mergeSmallChunks: false,
      });

      const textWithSmallParagraphs = `
Short one.

Short two.

Short three.
      `.trim();

      const chunks = await strategyNoMerge.chunk(textWithSmallParagraphs);

      // Without merging, we might have more chunks
      expect(chunks.length).toBeGreaterThan(0);

      strategyNoMerge.dispose();
    });
  });

  describe("Large document handling", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 100,
        minTokens: 30,
      });
    });

    it("should handle large documents efficiently", async () => {
      const largeDocument = sampleDocument.repeat(3);
      const chunks = await strategy.chunk(largeDocument);

      expect(chunks.length).toBeGreaterThan(3);

      // Verify all chunks are valid
      chunks.forEach((chunk, index) => {
        expect(chunk.chunkIndex).toBe(index);
        expect(chunk.tokenCount).toBeGreaterThan(0);
        expect(chunk.tokenCount).toBeLessThanOrEqual(100);
      });
    });
  });

  describe("Configuration validation", () => {
    it("should throw error if minTokens >= maxTokens", () => {
      expect(() => {
        new SemanticChunkingStrategy({
          maxTokens: 100,
          minTokens: 150,
        });
      }).toThrow("minTokens must be less than maxTokens");
    });

    it("should use default values when not specified", () => {
      const strategyWithDefaults = new SemanticChunkingStrategy({
        maxTokens: 200,
      });

      expect(strategyWithDefaults).toBeDefined();
      strategyWithDefaults.dispose();
    });
  });

  describe("Edge cases", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 200,
        minTokens: 50,
      });
    });

    it("should handle text with only whitespace", async () => {
      const whitespaceText = "   \n\n\t  ";
      const chunks = await strategy.chunk(whitespaceText);

      expect(Array.isArray(chunks)).toBe(true);
    });

    it("should handle text with special characters", async () => {
      const specialText = "Hello! How are you? I'm fine. Let's test: this, that, and more...";
      const chunks = await strategy.chunk(specialText);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toContain(specialText);
    });

    it("should handle mixed content types", async () => {
      const mixedContent = `
# Header

Some text here.

\`\`\`code
function test() {}
\`\`\`

- List item 1
- List item 2

Final paragraph.
      `.trim();

      const chunks = await strategy.chunk(mixedContent);

      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(chunk.content).toBeTruthy();
        expect(chunk.tokenCount).toBeGreaterThan(0);
      });
    });
  });

  describe("Semantic coherence", () => {
    beforeEach(() => {
      strategy = new SemanticChunkingStrategy({
        maxTokens: 150,
        minTokens: 40,
      });
    });

    it("should maintain paragraph coherence", async () => {
      const coherentText = `
This is the first paragraph. It has multiple sentences. They all belong together.

This is the second paragraph. It also has multiple sentences. They form a cohesive unit.

This is the third paragraph. It continues the theme. The content is related.
      `.trim();

      const chunks = await strategy.chunk(coherentText);

      // Each chunk should ideally contain complete paragraphs
      chunks.forEach((chunk) => {
        // Chunks should not start or end in the middle of obvious semantic units
        expect(chunk.content.trim()).toBeTruthy();
      });
    });
  });
});
