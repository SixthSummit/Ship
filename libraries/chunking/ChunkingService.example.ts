/**
 * Examples of using the ChunkingService for document processing
 *
 * This file demonstrates various use cases of the chunking service
 * for preparing documents for embedding and processing.
 */

import { ChunkingService } from "./ChunkingService.js";
import { FixedLengthChunkingStrategy } from "./strategies/FixedLengthChunkingStrategy.js";
import { SlidingWindowChunkingStrategy } from "./strategies/SlidingWindowChunkingStrategy.js";

// Sample document for demonstration
const sampleDocument = `
Artificial Intelligence (AI) has revolutionized many aspects of modern life. From healthcare to finance, AI systems are being deployed to solve complex problems.

Machine Learning, a subset of AI, enables computers to learn from data without being explicitly programmed. Deep learning, in turn, is a subset of machine learning that uses neural networks with multiple layers.

Natural Language Processing (NLP) is another important area of AI. It focuses on the interaction between computers and human language. NLP techniques are used in applications like chatbots, translation services, and sentiment analysis.

The future of AI holds great promise. Researchers are working on making AI systems more efficient, interpretable, and aligned with human values. As AI continues to evolve, it will likely play an increasingly important role in society.
`.trim();

/**
 * Example 1: Basic Fixed Length Chunking
 *
 * Use this when you want simple, non-overlapping chunks.
 * Perfect for basic document splitting.
 */
async function example1_BasicFixedLength() {
  console.log("\n=== Example 1: Basic Fixed Length Chunking ===\n");

  const service = ChunkingService.createWithFixedLength({
    maxTokens: 100,
  });

  const chunks = await service.chunk(sampleDocument);

  console.log(`Document split into ${chunks.length} chunks:`);
  chunks.forEach((chunk) => {
    console.log(`\nChunk ${chunk.chunkIndex + 1}:`);
    console.log(`  Tokens: ${chunk.tokenCount}`);
    console.log(`  Position: ${chunk.startIndex}-${chunk.endIndex}`);
    console.log(`  Content: ${chunk.content.substring(0, 80)}...`);
  });

  service.dispose();
}

/**
 * Example 2: Sliding Window Chunking
 *
 * Use this when you need context overlap between chunks.
 * Great for semantic search and embeddings where context matters.
 */
async function example2_SlidingWindow() {
  console.log("\n=== Example 2: Sliding Window Chunking ===\n");

  const service = ChunkingService.createWithSlidingWindow({
    maxTokens: 100,
    overlapTokens: 20, // 20% overlap
  });

  const chunks = await service.chunk(sampleDocument);

  console.log(`Document split into ${chunks.length} chunks with overlap:`);
  chunks.forEach((chunk, i) => {
    console.log(`\nChunk ${chunk.chunkIndex + 1}:`);
    console.log(`  Tokens: ${chunk.tokenCount}`);

    // Show overlap with next chunk
    if (i < chunks.length - 1) {
      const nextChunk = chunks[i + 1];
      const overlapStart = nextChunk.startIndex;
      const overlapEnd = chunk.endIndex;
      if (overlapStart < overlapEnd) {
        const overlapLength = overlapEnd - overlapStart;
        console.log(`  Overlap with next: ~${overlapLength} characters`);
      }
    }

    console.log(`  Content: ${chunk.content.substring(0, 80)}...`);
  });

  service.dispose();
}

/**
 * Example 3: Preparing Documents for Embedding
 *
 * This example shows how to chunk a document for generating embeddings.
 * Each chunk is prepared with metadata for later retrieval.
 */
async function example3_PrepareForEmbedding() {
  console.log("\n=== Example 3: Preparing for Embedding ===\n");

  const service = ChunkingService.createWithSlidingWindow({
    maxTokens: 512, // Typical embedding model limit
    overlapTokens: 50,
  });

  const chunks = await service.chunk(sampleDocument);

  // Prepare chunks with metadata for embedding
  const preparedChunks = chunks.map((chunk) => ({
    text: chunk.content,
    metadata: {
      chunkIndex: chunk.chunkIndex,
      tokenCount: chunk.tokenCount,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      documentId: "sample-doc-123",
      documentTitle: "AI Overview",
    },
  }));

  console.log(`Prepared ${preparedChunks.length} chunks for embedding:`);
  preparedChunks.forEach((prepared) => {
    console.log(`\nChunk ${prepared.metadata.chunkIndex + 1}:`);
    console.log(`  Tokens: ${prepared.metadata.tokenCount}`);
    console.log(`  Text: ${prepared.text.substring(0, 60)}...`);
    console.log(`  Ready for embedding generation`);
  });

  service.dispose();
}

/**
 * Example 4: Dynamic Strategy Switching
 *
 * This example shows how to switch between different chunking strategies
 * based on your needs.
 */
async function example4_StrategySwitching() {
  console.log("\n=== Example 4: Dynamic Strategy Switching ===\n");

  // Start with fixed length
  const service = ChunkingService.createWithFixedLength({
    maxTokens: 100,
  });

  console.log("Using Fixed Length Strategy:");
  let chunks = await service.chunk(sampleDocument);
  console.log(`  Generated ${chunks.length} chunks`);

  // Switch to sliding window
  const slidingStrategy = new SlidingWindowChunkingStrategy({
    maxTokens: 100,
    overlapTokens: 20,
  });
  service.setStrategy(slidingStrategy);

  console.log("\nSwitched to Sliding Window Strategy:");
  chunks = await service.chunk(sampleDocument);
  console.log(`  Generated ${chunks.length} chunks (with overlap)`);

  service.dispose();
}

/**
 * Example 5: Custom Strategy for Specific Use Case
 *
 * This example demonstrates how to implement a custom chunking strategy
 * for specialized needs.
 */
async function example5_CustomStrategy() {
  console.log("\n=== Example 5: Custom Strategy ===\n");

  // Custom strategy that chunks by paragraphs
  const service = new ChunkingService(
    new FixedLengthChunkingStrategy({
      maxTokens: 200,
    }),
  );

  const chunks = await service.chunk(sampleDocument);

  console.log(`Custom chunking produced ${chunks.length} chunks`);
  console.log("First chunk preview:");
  console.log(chunks[0].content.substring(0, 100) + "...");

  service.dispose();
}

/**
 * Example 6: Processing Large Documents
 *
 * This example shows how to process a large document in chunks,
 * simulating a real-world use case like indexing for search.
 */
async function example6_ProcessingLargeDocument() {
  console.log("\n=== Example 6: Processing Large Documents ===\n");

  // Simulate a larger document
  const largeDocument = sampleDocument.repeat(5);

  const service = ChunkingService.createWithSlidingWindow({
    maxTokens: 200,
    overlapTokens: 30,
  });

  const chunks = await service.chunk(largeDocument);

  console.log(`Large document statistics:`);
  console.log(`  Original length: ${largeDocument.length} characters`);
  console.log(`  Number of chunks: ${chunks.length}`);
  console.log(
    `  Average chunk size: ${Math.round(chunks.reduce((sum, c) => sum + c.tokenCount, 0) / chunks.length)} tokens`,
  );
  console.log(`  Min tokens: ${Math.min(...chunks.map((c) => c.tokenCount))}`);
  console.log(`  Max tokens: ${Math.max(...chunks.map((c) => c.tokenCount))}`);

  // Simulate processing each chunk
  console.log("\nProcessing chunks:");
  for (const chunk of chunks) {
    // In a real application, you might:
    // - Generate embeddings
    // - Store in a vector database
    // - Index for search
    console.log(`  Processing chunk ${chunk.chunkIndex + 1}/${chunks.length}...`);
  }
  console.log("Processing complete!");

  service.dispose();
}

/**
 * Example 7: Handling Different Encodings
 *
 * This example shows how to use different token encodings
 * for different model types.
 */
async function example7_DifferentEncodings() {
  console.log("\n=== Example 7: Different Encodings ===\n");

  // For GPT-3.5/GPT-4 (default)
  const gptService = ChunkingService.createWithFixedLength({
    maxTokens: 100,
    encoding: "cl100k_base",
  });

  // For code models
  const codeService = ChunkingService.createWithFixedLength({
    maxTokens: 100,
    encoding: "p50k_base",
  });

  const gptChunks = await gptService.chunk(sampleDocument);
  const codeChunks = await codeService.chunk(sampleDocument);

  console.log(`GPT encoding (cl100k_base): ${gptChunks.length} chunks`);
  console.log(`Code encoding (p50k_base): ${codeChunks.length} chunks`);

  gptService.dispose();
  codeService.dispose();
}

/**
 * Run all examples
 */
async function runAllExamples() {
  console.log("===================================");
  console.log("   Chunking Service Examples");
  console.log("===================================");

  await example1_BasicFixedLength();
  await example2_SlidingWindow();
  await example3_PrepareForEmbedding();
  await example4_StrategySwitching();
  await example5_CustomStrategy();
  await example6_ProcessingLargeDocument();
  await example7_DifferentEncodings();

  console.log("\n===================================");
  console.log("   All examples completed!");
  console.log("===================================\n");
}

// Export examples for use in other files
export {
  example1_BasicFixedLength,
  example2_SlidingWindow,
  example3_PrepareForEmbedding,
  example4_StrategySwitching,
  example5_CustomStrategy,
  example6_ProcessingLargeDocument,
  example7_DifferentEncodings,
  runAllExamples,
};

// If running directly, execute all examples
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples().catch(console.error);
}
