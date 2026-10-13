# Chunking Library - Troubleshooting

Common issues, their causes, and solutions when working with the chunking library.

## 🔍 Quick Diagnosis

| Symptom | Likely Cause | Jump To |
|---------|-------------|---------|
| Empty array returned | Empty/whitespace input | [Empty Chunks](#empty-chunks) |
| Chunks too small | minTokens too low or merging disabled | [Chunk Size Issues](#chunk-size-issues) |
| Chunks too large | maxTokens set too high | [Chunk Size Issues](#chunk-size-issues) |
| Token count doesn't match expectations | Wrong encoding | [Token Count Mismatch](#token-count-mismatch) |
| Memory grows over time | Missing `dispose()` calls | [Memory Usage](#memory-usage) |
| Code blocks split across chunks | Using Fixed Length strategy | [Code Block Splitting](#code-block-splitting) |
| Sentences split mid-word | Using Fixed Length strategy | [Mid-Word Splits](#mid-word-splits) |
| Slow processing | Large documents or wrong strategy | [Performance Issues](#performance-issues) |
| Constructor throws error | Invalid options | [Configuration Errors](#configuration-errors) |

---

## Empty Chunks

### Symptom
`chunk()` returns an empty array `[]`.

### Cause
The input text is empty, null, undefined, or contains only whitespace.

### Solution

```typescript
// ChunkingService handles this automatically
const chunks = await service.chunk("");       // → []
const chunks = await service.chunk("   ");    // → []
const chunks = await service.chunk("\n\n");   // → []
```

Check your input before chunking:

```typescript
if (!text || text.trim().length === 0) {
  console.warn("Skipping empty document");
  return [];
}

const chunks = await service.chunk(text);
```

---

## Chunk Size Issues

### Chunks Too Small

**Symptom:** Many chunks with very few tokens (10-50 tokens).

**Causes:**
- `minTokens` set too low (Semantic strategy)
- `mergeSmallChunks` disabled (Semantic strategy)
- Document has many small sections

**Solutions:**

```typescript
// Increase minTokens
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 150,         // Increase from default 100
  mergeSmallChunks: true,  // Ensure merging is enabled
});
```

### Chunks Too Large

**Symptom:** Chunks exceed your embedding model's token limit.

**Cause:** `maxTokens` set higher than your model supports.

**Solution:**

```typescript
// Match your embedding model's limit
const service = ChunkingService.createWithSemantic({
  maxTokens: 480,  // Leave headroom below model's 512 limit
});
```

### Inconsistent Chunk Sizes

**Symptom:** Large variance in chunk sizes with Semantic strategy.

**Cause:** This is expected behavior - the Semantic strategy creates chunks based on document structure, not uniform size.

**Solutions:**
- If you need consistent sizes, use Fixed Length strategy
- Adjust `minTokens` and `mergeSmallChunks` to reduce small chunks
- Accept some variance as a tradeoff for semantic quality

---

## Token Count Mismatch

### Symptom
Token counts don't match what you expect from another tokenizer.

### Cause
Different tokenizers produce different token counts. The library uses tiktoken with `cl100k_base` by default (OpenAI's encoding for GPT-3.5/4).

### Solution

Ensure your encoding matches your target model:

```typescript
// For OpenAI GPT-3.5/4 and text-embedding-3-*
{ encoding: "cl100k_base" }  // Default

// For older GPT-3 models
{ encoding: "p50k_base" }

// For code models
{ encoding: "p50k_base" }
```

**Verify token counts:**

```typescript
import { get_encoding } from "tiktoken";

const encoder = get_encoding("cl100k_base");
const tokens = encoder.encode("Your text here");
console.log(`Token count: ${tokens.length}`);
encoder.free();
```

---

## Memory Usage

### Symptom
Memory usage grows over time, especially in long-running applications.

### Cause
The tiktoken encoder uses native (WASM) memory that isn't managed by JavaScript's garbage collector. Failing to call `dispose()` leaks this memory.

### Solution

**Always call `dispose()` when done:**

```typescript
// Pattern 1: try/finally
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
try {
  const chunks = await service.chunk(text);
  return chunks;
} finally {
  service.dispose();
}

// Pattern 2: Singleton with cleanup
class ChunkingManager {
  private service: ChunkingService;

  constructor() {
    this.service = ChunkingService.createWithSemantic({ maxTokens: 512 });
  }

  async chunk(text: string) {
    return await this.service.chunk(text);
  }

  // Call on application shutdown
  shutdown() {
    this.service.dispose();
  }
}
```

**For batch processing, reuse one instance:**

```typescript
// Good: single instance for many documents
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
try {
  for (const doc of documents) {
    const chunks = await service.chunk(doc.content);
    await processChunks(chunks);
  }
} finally {
  service.dispose();
}

// Bad: creating and leaking instances
for (const doc of documents) {
  const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
  const chunks = await service.chunk(doc.content);
  // Missing dispose() - leaks memory each iteration!
}
```

---

## Code Block Splitting

### Symptom
Code blocks are split across multiple chunks, breaking syntax.

### Cause
Using Fixed Length strategy, which has no awareness of code blocks.

### Solution

Use **Semantic** or **Sliding Window** strategy:

```typescript
// Semantic: preserves code blocks as single units
const service = ChunkingService.createWithSemantic({
  maxTokens: 1024,  // Larger to accommodate big code blocks
  minTokens: 100,
});

// Sliding Window: protects code blocks from splitting
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,
});
```

> **Note:** If a single code block exceeds `maxTokens`, the Semantic strategy will split it by sentences as a fallback. Consider increasing `maxTokens` for code-heavy documents.

---

## Mid-Word Splits

### Symptom
Chunks end in the middle of a word.

### Cause
Fixed Length strategy splits on token boundaries, and a single word can span multiple tokens. When split, the token-to-text decoding may cut within a word.

### Solution

Use Sliding Window or Semantic strategy, which respect word/sentence boundaries:

```typescript
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,
  preferParagraphBoundaries: true,
});
```

---

## Performance Issues

### Symptom
Chunking takes longer than expected.

### Causes and Solutions

**Large documents:**

```typescript
// For very large documents (100KB+), consider pre-splitting
const sections = document.split(/(?=^# )/gm);  // Split by H1 headers
const allChunks = [];
for (const section of sections) {
  const chunks = await service.chunk(section);
  allChunks.push(...chunks);
}
```

**Wrong strategy for the job:**

| Document Size | Strategy Choice |
|--------------|-----------------|
| < 10KB | Any strategy is fine |
| 10-100KB | Semantic or Sliding Window |
| 100KB-1MB | Fixed Length for speed, Semantic for quality |
| > 1MB | Pre-split, then use any strategy |

**Repeated service creation:**

```typescript
// Bad: creates new encoder each time
for (const doc of docs) {
  const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
  const chunks = await service.chunk(doc);
  service.dispose();
}

// Good: reuse one service
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
for (const doc of docs) {
  const chunks = await service.chunk(doc);
}
service.dispose();
```

---

## Configuration Errors

### `overlapTokens must be less than maxTokens`

**Cause:** Sliding Window's `overlapTokens` is >= `maxTokens`.

**Fix:**
```typescript
// Wrong
{ maxTokens: 512, overlapTokens: 512 }
{ maxTokens: 512, overlapTokens: 600 }

// Correct: overlap should be 10-25% of maxTokens
{ maxTokens: 512, overlapTokens: 80 }
```

### `minChunkRatio must be between 0.1 and 0.9`

**Cause:** Sliding Window's `minChunkRatio` is outside valid range.

**Fix:**
```typescript
// Wrong
{ maxTokens: 512, overlapTokens: 80, minChunkRatio: 0.0 }
{ maxTokens: 512, overlapTokens: 80, minChunkRatio: 1.0 }

// Correct
{ maxTokens: 512, overlapTokens: 80, minChunkRatio: 0.5 }
```

### `minTokens must be less than maxTokens`

**Cause:** Semantic strategy's `minTokens` is >= `maxTokens`.

**Fix:**
```typescript
// Wrong
{ maxTokens: 512, minTokens: 512 }
{ maxTokens: 256, minTokens: 300 }

// Correct: minTokens should be much less than maxTokens
{ maxTokens: 512, minTokens: 100 }
```

---

## Large Documents

### Symptom
Processing very large documents (1MB+) is slow or uses excessive memory.

### Solution

**Pre-split by natural boundaries:**

```typescript
function preSplitDocument(text: string, maxSectionSize: number = 50000): string[] {
  // Split by major headers
  const sections = text.split(/(?=^#{1,2}\s)/gm);

  // Merge small sections, split large ones
  const result: string[] = [];
  let current = "";

  for (const section of sections) {
    if (current.length + section.length > maxSectionSize && current.length > 0) {
      result.push(current);
      current = section;
    } else {
      current += section;
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

// Usage
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
const sections = preSplitDocument(largeDocument);
const allChunks = [];

for (const section of sections) {
  const chunks = await service.chunk(section);
  allChunks.push(...chunks);
}

// Re-index chunk numbers
allChunks.forEach((chunk, i) => { chunk.chunkIndex = i; });

service.dispose();
```

---

## Unicode and Special Characters

### Symptom
Unexpected behavior with non-ASCII text (CJK characters, emoji, etc.).

### Cause
Token counts for non-ASCII text differ significantly from ASCII. A single Chinese character may be 2-3 tokens.

### Solution

Test with representative content and adjust `maxTokens`:

```typescript
// For CJK-heavy content, tokens per character is higher
// Adjust maxTokens accordingly
const service = ChunkingService.createWithSemantic({
  maxTokens: 256,  // Lower limit for CJK content
  minTokens: 50,
});
```

---

## Strategy Not Matching Expected Behavior

### Symptom
`ChunkingService.create()` selects the wrong strategy.

### Cause
The auto-detection in `create()` uses option presence to determine strategy:

| Options Present | Strategy |
|----------------|----------|
| `overlapTokens` | Sliding Window |
| `minTokens` or `mergeSmallChunks` | Semantic |
| Only `maxTokens` | Fixed Length |

### Solution

Use explicit factory methods instead of auto-detection:

```typescript
// Explicit (recommended)
const service = ChunkingService.createWithSemantic({ maxTokens: 512, minTokens: 100 });
const service = ChunkingService.createWithSlidingWindow({ maxTokens: 512, overlapTokens: 80 });
const service = ChunkingService.createWithFixedLength({ maxTokens: 512 });

// Auto-detection (may be ambiguous)
const service = ChunkingService.create(options);
```

---

## Debugging Tips

### Inspect Chunks

```typescript
const chunks = await service.chunk(text);

// Print chunk summary
console.log(`Total chunks: ${chunks.length}`);
console.log(`Total tokens: ${chunks.reduce((sum, c) => sum + c.tokenCount, 0)}`);

for (const chunk of chunks) {
  console.log(`\n--- Chunk ${chunk.chunkIndex} ---`);
  console.log(`Tokens: ${chunk.tokenCount}`);
  console.log(`Characters: ${chunk.content.length}`);
  console.log(`Position: ${chunk.startIndex}-${chunk.endIndex}`);
  console.log(`Preview: ${chunk.content.substring(0, 100)}...`);
}
```

### Verify Character Indices

```typescript
for (const chunk of chunks) {
  const extracted = originalText.substring(chunk.startIndex, chunk.endIndex);
  const matches = extracted.trim() === chunk.content.trim();
  if (!matches) {
    console.warn(`Chunk ${chunk.chunkIndex}: index mismatch`);
    console.warn(`  Expected: "${chunk.content.substring(0, 50)}..."`);
    console.warn(`  Got:      "${extracted.substring(0, 50)}..."`);
  }
}
```

### Compare Strategies

```typescript
const text = loadTestDocument();

const strategies = [
  { name: "Fixed", service: ChunkingService.createWithFixedLength({ maxTokens: 512 }) },
  { name: "Sliding", service: ChunkingService.createWithSlidingWindow({ maxTokens: 512, overlapTokens: 80 }) },
  { name: "Semantic", service: ChunkingService.createWithSemantic({ maxTokens: 512, minTokens: 100 }) },
];

for (const { name, service } of strategies) {
  const start = Date.now();
  const chunks = await service.chunk(text);
  const elapsed = Date.now() - start;

  const tokenCounts = chunks.map(c => c.tokenCount);
  const avg = tokenCounts.reduce((a, b) => a + b, 0) / tokenCounts.length;

  console.log(`${name}: ${chunks.length} chunks, avg ${avg.toFixed(0)} tokens, ${elapsed}ms`);
  service.dispose();
}
```

---

## Getting Help

If your issue isn't covered here:

1. **Check the tests** - Strategy test files contain examples of expected behavior
2. **Review the source** - Strategies are well-commented with algorithm explanations
3. **Test with simple input** - Isolate the issue with minimal text
4. **Compare strategies** - Try a different strategy to see if the issue is strategy-specific

## Related Documentation

- [API Reference](api-reference.md) - Error handling details
- [Configuration Guide](configuration.md) - Valid option ranges
- [Strategies Guide](strategies.md) - Strategy behavior details
- [Best Practices](best-practices.md) - Production optimization
