# Chunking Library - Quick Start Guide

Get up and running with the chunking library in 5 minutes.

## 📦 What You Get

The chunking library provides:
- ✅ Three chunking strategies (Fixed Length, Sliding Window, Semantic)
- ✅ Accurate token counting via tiktoken (OpenAI-compatible)
- ✅ Structure-aware chunking that preserves meaning
- ✅ Strategy pattern for runtime flexibility
- ✅ Factory methods for quick setup
- ✅ Full TypeScript type safety

## 🚀 Quick Start

### 1. Import the Library

```typescript
import { ChunkingService } from "@sixthsummit/ship-api/libraries/chunking";
```

Or import specific pieces:

```typescript
import {
  ChunkingService,
  SemanticChunkingStrategy,
  SlidingWindowChunkingStrategy,
  FixedLengthChunkingStrategy,
} from "@sixthsummit/ship-api/libraries/chunking";
import type { TextChunk, SemanticChunkingOptions } from "@sixthsummit/ship-api/libraries/chunking";
```

### 2. Chunk Your Text

**Recommended: Semantic Chunking (best for RAG)**

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 100,
  mergeSmallChunks: true,
});

const chunks = await service.chunk(documentText);

console.log(`Created ${chunks.length} chunks`);
for (const chunk of chunks) {
  console.log(`Chunk ${chunk.chunkIndex}: ${chunk.tokenCount} tokens`);
  console.log(chunk.content.substring(0, 100) + "...");
}
```

**That's it!** Your document is now chunked and ready for embedding.

### 3. Understand the Output

Each chunk is a `TextChunk` object:

```typescript
interface TextChunk {
  content: string;      // The text content of the chunk
  startIndex: number;   // Starting character position in original document
  endIndex: number;     // Ending character position in original document
  tokenCount: number;   // Number of tokens in this chunk
  chunkIndex: number;   // Chunk number (0-indexed)
}
```

**Example output:**

```json
[
  {
    "content": "# Introduction\n\nThis document covers...",
    "startIndex": 0,
    "endIndex": 1523,
    "tokenCount": 487,
    "chunkIndex": 0
  },
  {
    "content": "## Architecture\n\nThe system uses...",
    "startIndex": 1524,
    "endIndex": 2891,
    "tokenCount": 412,
    "chunkIndex": 1
  }
]
```

### 4. Clean Up

Always dispose the service when done to free tokenizer resources:

```typescript
service.dispose();
```

## 🎯 Common Use Cases

### Use Case 1: Chunk for Embedding Pipeline

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,    // Match your embedding model's limit
  minTokens: 100,    // Avoid tiny, meaningless chunks
  mergeSmallChunks: true,
});

const chunks = await service.chunk(document);

// Send chunks to your embedding service
for (const chunk of chunks) {
  const embedding = await embeddingService.embed(chunk.content);
  await vectorStore.upsert({
    id: `doc-${docId}-chunk-${chunk.chunkIndex}`,
    content: chunk.content,
    embedding,
    metadata: {
      docId,
      chunkIndex: chunk.chunkIndex,
      startIndex: chunk.startIndex,
      endIndex: chunk.endIndex,
      tokenCount: chunk.tokenCount,
    },
  });
}

service.dispose();
```

### Use Case 2: Narrative Content with Context Overlap

```typescript
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,              // ~15% overlap for context
  preferParagraphBoundaries: true, // End at paragraph breaks
  minChunkRatio: 0.5,             // Minimum 50% of maxTokens
});

const chunks = await service.chunk(articleText);

// Chunks overlap, so search results have better context
for (const chunk of chunks) {
  console.log(`Chunk ${chunk.chunkIndex}: ${chunk.tokenCount} tokens`);
}

service.dispose();
```

### Use Case 3: Fast Prototyping

```typescript
const service = ChunkingService.createWithFixedLength({
  maxTokens: 256,
});

const chunks = await service.chunk(text);
console.log(`Split into ${chunks.length} chunks`);

service.dispose();
```

### Use Case 4: Auto-Detect Strategy from Options

```typescript
// The factory auto-detects the strategy based on which options are provided
const service = ChunkingService.create({
  maxTokens: 512,
  overlapTokens: 80,  // Presence of overlapTokens → Sliding Window
});

// Or:
const service2 = ChunkingService.create({
  maxTokens: 512,
  minTokens: 100,     // Presence of minTokens → Semantic
});

// Or:
const service3 = ChunkingService.create({
  maxTokens: 512,     // Only maxTokens → Fixed Length
});
```

### Use Case 5: Switch Strategy at Runtime

```typescript
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });

// Chunk structured documents with semantic strategy
const structuredChunks = await service.chunk(technicalDoc);

// Switch to sliding window for narrative content
service.setStrategy(
  new SlidingWindowChunkingStrategy({
    maxTokens: 512,
    overlapTokens: 80,
  })
);

const narrativeChunks = await service.chunk(blogPost);

service.dispose();
```

## 🧪 Testing

```typescript
import { ChunkingService } from "@sixthsummit/ship-api/libraries/chunking";

// Quick test
const service = ChunkingService.createWithSemantic({
  maxTokens: 256,
  minTokens: 50,
});

const testText = `
# Test Document

This is the first paragraph with some content that should be
kept together as a semantic unit.

## Section Two

This is another section with different content. It should be
in a separate chunk if possible.

- Item one in a list
- Item two in a list
- Item three in a list
`;

const chunks = await service.chunk(testText);

console.log(`Created ${chunks.length} chunks:`);
chunks.forEach((chunk) => {
  console.log(`  Chunk ${chunk.chunkIndex}: ${chunk.tokenCount} tokens`);
  console.log(`    "${chunk.content.substring(0, 60)}..."`);
});

service.dispose();
```

## 📚 Next Steps

### Learn More

1. **[Strategies Guide](strategies.md)** - Deep dive into each strategy
2. **[Configuration Guide](configuration.md)** - Tune for your use case
3. **[API Reference](api-reference.md)** - Complete API documentation
4. **[Best Practices](best-practices.md)** - Production optimization

### Common Tasks

**Choose the right strategy:**
```
Structured docs (markdown, HTML, code) → Semantic
Narrative text (articles, stories)     → Sliding Window
Quick prototype or uniform text        → Fixed Length
```

**Set chunk size for your embedding model:**

| Embedding Model | Recommended maxTokens |
|-----------------|----------------------|
| OpenAI text-embedding-3-small | 512 |
| OpenAI text-embedding-3-large | 512 - 1024 |
| Cohere embed-v3 | 512 |
| BGE / E5 models | 512 |
| Custom models | Check model's max input |

**Handle different document types:**

| Document Type | Strategy | Key Options |
|---------------|----------|-------------|
| Technical docs | Semantic | `maxTokens: 512, minTokens: 100` |
| Blog posts | Sliding Window | `overlapTokens: 80` |
| Code files | Semantic | `maxTokens: 1024, mergeSmallChunks: true` |
| Legal documents | Sliding Window | `overlapTokens: 128` |
| Chat transcripts | Fixed Length | `maxTokens: 256` |

## ✅ Checklist

- [ ] Import the library
- [ ] Choose a strategy (Semantic recommended)
- [ ] Configure token limits for your embedding model
- [ ] Chunk your documents
- [ ] Store chunk metadata alongside embeddings
- [ ] Call `dispose()` when done
- [ ] Test with representative documents

## 🚀 You're Ready!

Start chunking documents for your RAG pipeline. The semantic strategy handles most use cases out of the box with sensible defaults.

**Questions?** See the [API Reference](api-reference.md) or [Strategies Guide](strategies.md).
