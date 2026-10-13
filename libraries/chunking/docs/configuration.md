# Chunking Library - Configuration Guide

Complete guide to configuring and tuning the chunking library for optimal results.

## ⚙️ Configuration Overview

Every strategy accepts a configuration object at construction time. All options use sensible defaults so you can start with minimal configuration and tune as needed.

| Option | Strategies | Required | Default | Description |
|--------|-----------|----------|---------|-------------|
| `maxTokens` | All | Yes | - | Maximum tokens per chunk |
| `encoding` | All | No | `cl100k_base` | Token encoding name |
| `overlapTokens` | Sliding Window | Yes | - | Overlap between chunks |
| `minChunkRatio` | Sliding Window | No | `0.5` | Min chunk size ratio |
| `preferParagraphBoundaries` | Sliding Window | No | `true` | Prefer paragraph breaks |
| `minTokens` | Semantic | No | `100` | Minimum tokens per chunk |
| `mergeSmallChunks` | Semantic | No | `true` | Auto-merge small chunks |

---

## Token Limits

### maxTokens

The most important configuration option. Sets the upper bound on tokens per chunk.

**Guidelines:**
- Match your embedding model's maximum input size
- Leave headroom for metadata if you prepend context to chunks
- Smaller chunks = more precise retrieval but less context
- Larger chunks = more context but less precise retrieval

```typescript
// Conservative (good retrieval precision)
{ maxTokens: 256 }

// Balanced (recommended default)
{ maxTokens: 512 }

// Large context (more context per chunk)
{ maxTokens: 1024 }
```

### Embedding Model Alignment

Choose `maxTokens` based on your embedding model:

| Embedding Model | Max Input Tokens | Recommended maxTokens |
|-----------------|-----------------|----------------------|
| OpenAI `text-embedding-3-small` | 8,191 | 512 |
| OpenAI `text-embedding-3-large` | 8,191 | 512 - 1,024 |
| OpenAI `text-embedding-ada-002` | 8,191 | 512 |
| Cohere `embed-english-v3.0` | 512 | 480 |
| Cohere `embed-multilingual-v3.0` | 512 | 480 |
| Google `text-embedding-004` | 2,048 | 512 - 1,024 |
| BGE models | 512 | 480 |
| E5 models | 512 | 480 |
| Nomic `nomic-embed-text-v1.5` | 8,192 | 512 - 1,024 |

> **Tip:** Even when models support large inputs, 512 tokens is often the sweet spot for RAG retrieval quality. Larger chunks provide more context but can dilute relevance.

---

## Token Encodings

### Supported Encodings

The `encoding` option controls how text is tokenized. This should match your target model's tokenizer.

| Encoding | Models | Tokens/Word (avg) |
|----------|--------|-------------------|
| `cl100k_base` | GPT-3.5-turbo, GPT-4, text-embedding-3-* | ~1.3 |
| `p50k_base` | Code models, older GPT-3 | ~1.3 |
| `r50k_base` | Older GPT-3 (davinci, curie) | ~1.3 |
| `gpt2` | GPT-2 models | ~1.5 |

**Default:** `cl100k_base` (best for modern OpenAI models)

```typescript
// Default (GPT-3.5/4 compatible)
{ maxTokens: 512, encoding: "cl100k_base" }

// For older models
{ maxTokens: 512, encoding: "p50k_base" }
```

### Encoding Fallback

If an invalid encoding name is provided, the library automatically falls back to `gpt-3.5-turbo` encoding (which uses `cl100k_base`):

```typescript
// This won't throw - falls back gracefully
{ maxTokens: 512, encoding: "invalid_encoding_name" }
// → Uses cl100k_base internally
```

---

## Overlap Configuration

### overlapTokens (Sliding Window only)

Controls how many tokens overlap between adjacent chunks. Overlap provides context continuity at chunk boundaries.

```typescript
{
  maxTokens: 512,
  overlapTokens: 80,  // ~15% overlap
}
```

**How overlap works:**

```
stepSize = maxTokens - overlapTokens
         = 512 - 80 = 432

Chunk 1: tokens[0..512]
Chunk 2: tokens[432..944]     ← starts 432 tokens later
Chunk 3: tokens[864..1376]    ← starts 432 tokens later
                  ↑
         80 tokens shared between adjacent chunks
```

**Recommendations:**

| Overlap % | overlapTokens (512 max) | Use Case |
|-----------|------------------------|----------|
| 10% | ~50 | Short, independent paragraphs |
| 15% | ~80 | **General purpose (recommended)** |
| 20% | ~100 | Dense technical or legal text |
| 25% | ~128 | Highly interconnected content |

**Tradeoffs:**
- More overlap = better context preservation at boundaries
- More overlap = more total chunks (increases storage and embedding costs)
- More overlap = slower processing (smaller step size)

**Constraints:**
- Must be less than `maxTokens`
- Recommended: 10-25% of `maxTokens`

---

## Boundary Configuration

### preferParagraphBoundaries (Sliding Window only)

When `true`, the sliding window strategy tries to end chunks at paragraph boundaries (double newlines) before falling back to sentence boundaries.

```typescript
// Prefer paragraph boundaries (default)
{ maxTokens: 512, overlapTokens: 80, preferParagraphBoundaries: true }

// Only use sentence boundaries
{ maxTokens: 512, overlapTokens: 80, preferParagraphBoundaries: false }
```

**When to disable:**
- Content has very long paragraphs (would create undersized chunks)
- Content doesn't use paragraph breaks
- You want more consistent chunk sizes

### minChunkRatio (Sliding Window only)

Controls the minimum acceptable chunk size when snapping to boundaries. Expressed as a ratio of the full chunk length.

```typescript
// Default: chunks must be at least 50% of maxTokens
{ maxTokens: 512, overlapTokens: 80, minChunkRatio: 0.5 }

// More aggressive boundary snapping (smaller chunks OK)
{ maxTokens: 512, overlapTokens: 80, minChunkRatio: 0.3 }

// Conservative (larger minimum chunks)
{ maxTokens: 512, overlapTokens: 80, minChunkRatio: 0.7 }
```

**Valid range:** 0.1 to 0.9

**How it works:**
- When a paragraph/sentence boundary is found, check if the resulting chunk size is >= `minChunkRatio * chunkLength`
- If too small, skip that boundary and use the next one or fall back to no adjustment

---

## Semantic Configuration

### minTokens (Semantic only)

Sets the minimum token count for chunks. Chunks smaller than this threshold are merged with adjacent chunks (if `mergeSmallChunks` is true).

```typescript
// Default: merge chunks under 100 tokens
{ maxTokens: 512, minTokens: 100 }

// Stricter: merge chunks under 150 tokens
{ maxTokens: 512, minTokens: 150 }

// Lenient: allow small chunks down to 50 tokens
{ maxTokens: 512, minTokens: 50 }
```

**Guidelines:**
- Higher values = fewer, larger chunks (less fragmentation)
- Lower values = more chunks that closely match document structure
- Too high = forces unrelated content together
- Too low = creates tiny, low-quality chunks

**Constraint:** Must be less than `maxTokens`

### mergeSmallChunks (Semantic only)

Controls whether chunks below `minTokens` are automatically merged with their neighbors.

```typescript
// Enable merging (default - recommended)
{ maxTokens: 512, minTokens: 100, mergeSmallChunks: true }

// Disable merging (preserve exact structure)
{ maxTokens: 512, minTokens: 100, mergeSmallChunks: false }
```

**When to disable:**
- You want chunks to exactly mirror the document structure
- Each semantic unit is independently meaningful regardless of size
- You're doing per-section processing rather than RAG

---

## Performance Tuning

### Chunk Size vs. Performance

| maxTokens | Chunks per 10KB | Processing Time | Memory |
|-----------|----------------|-----------------|--------|
| 128 | ~30 | Higher | Lower |
| 256 | ~15 | Medium | Lower |
| 512 | ~8 | Medium | Medium |
| 1024 | ~4 | Lower | Higher |
| 2048 | ~2 | Lowest | Higher |

### Memory Management

The tiktoken encoder uses native memory. Always dispose:

```typescript
// Pattern 1: try/finally
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
try {
  return await service.chunk(text);
} finally {
  service.dispose();
}

// Pattern 2: Reuse the service
class DocumentProcessor {
  private chunkingService: ChunkingService;

  constructor() {
    this.chunkingService = ChunkingService.createWithSemantic({ maxTokens: 512 });
  }

  async processDocument(text: string): Promise<TextChunk[]> {
    return await this.chunkingService.chunk(text);
  }

  destroy(): void {
    this.chunkingService.dispose();
  }
}
```

### Batch Processing

For large document sets, reuse a single service instance:

```typescript
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });

try {
  for (const document of documents) {
    const chunks = await service.chunk(document.content);
    await storeChunks(document.id, chunks);
  }
} finally {
  service.dispose();
}
```

---

## Quality Metrics

### Measuring Chunk Quality

After configuring your chunking pipeline, evaluate quality using these metrics:

| Metric | What It Measures | Target |
|--------|-----------------|--------|
| **Avg chunk size** | Token utilization | 60-90% of maxTokens |
| **Size variance** | Consistency | Low (< 30% coefficient of variation) |
| **Boundary coherence** | Semantic completeness | Chunks end at natural breaks |
| **Retrieval accuracy** | End-to-end quality | Measured by your eval suite |

### Quick Quality Check

```typescript
const service = ChunkingService.createWithSemantic({ maxTokens: 512, minTokens: 100 });
const chunks = await service.chunk(document);

// Calculate statistics
const tokenCounts = chunks.map(c => c.tokenCount);
const avg = tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length;
const min = Math.min(...tokenCounts);
const max = Math.max(...tokenCounts);
const variance = tokenCounts.reduce((sum, t) => sum + (t - avg) ** 2, 0) / tokenCounts.length;
const stddev = Math.sqrt(variance);

console.log(`Chunks: ${chunks.length}`);
console.log(`Avg tokens: ${avg.toFixed(0)}`);
console.log(`Min tokens: ${min}`);
console.log(`Max tokens: ${max}`);
console.log(`Std deviation: ${stddev.toFixed(0)}`);
console.log(`Utilization: ${(avg / 512 * 100).toFixed(1)}%`);

service.dispose();
```

---

## Recommended Configurations

### Production RAG (General Purpose)

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 100,
  mergeSmallChunks: true,
  encoding: "cl100k_base",
});
```

### Technical Documentation

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 150,         // Technical sections tend to be longer
  mergeSmallChunks: true,
  encoding: "cl100k_base",
});
```

### Narrative Content / Articles

```typescript
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,
  preferParagraphBoundaries: true,
  minChunkRatio: 0.5,
  encoding: "cl100k_base",
});
```

### Code Documentation / READMEs

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 1024,         // Code blocks can be large
  minTokens: 100,
  mergeSmallChunks: true,
  encoding: "cl100k_base",
});
```

### Short-Form Content (FAQs, Product Descriptions)

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 256,
  minTokens: 50,
  mergeSmallChunks: true,
  encoding: "cl100k_base",
});
```

### High-Overlap Retrieval (Legal, Academic)

```typescript
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 128,       // 25% overlap
  preferParagraphBoundaries: true,
  minChunkRatio: 0.4,
  encoding: "cl100k_base",
});
```

### Fast Batch Processing

```typescript
const service = ChunkingService.createWithFixedLength({
  maxTokens: 512,
  encoding: "cl100k_base",
});
```

---

## Related Documentation

- [API Reference](api-reference.md) - Complete class and method docs
- [Strategies Guide](strategies.md) - Strategy deep dive
- [Best Practices](best-practices.md) - Production optimization
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
