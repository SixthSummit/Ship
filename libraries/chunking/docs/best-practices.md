# Chunking Library - Best Practices

Production guidance for document chunking in RAG and embedding applications.

## 📋 Why Chunking Quality Matters

Document chunking is a critical step in preparing text for embedding models and vector databases. The quality of your chunks directly impacts:

- **Retrieval Accuracy**: Better chunks = better search results
- **Context Preservation**: Maintaining semantic meaning across splits
- **Embedding Quality**: Clean, coherent chunks produce better embeddings
- **System Performance**: Optimal chunk sizes improve speed and efficiency

Embedding models have token limits (typically 512-8192 tokens). Proper chunking ensures documents fit within model limits while preserving semantic coherence and optimizing retrieval precision.

## 🎯 Strategy Selection

### Quick Decision Guide

```
What type of content do you have?

Structured (docs, wikis, code)
  └─> Use Semantic Chunking ⭐⭐
      Best quality, preserves structure

Narrative (blogs, articles, essays)
  └─> Use Sliding Window ⭐
      Context preservation, smooth flow

Simple/uniform text
  └─> Use Fixed Length
      Fast processing, predictable sizes
```

### Use Semantic Chunking When (Recommended)

1. Documents have clear structure (headers, sections)
2. Content includes code blocks, lists, or mixed formats
3. Retrieval accuracy is critical
4. Building a production RAG system
5. Working with technical documentation

### Use Sliding Window When

1. Content is mostly prose without clear structure
2. Context preservation across boundaries matters
3. You need overlap between chunks for better retrieval
4. Working with narrative text, legal, or academic content

### Use Fixed Length When

1. Content is uniform and unstructured
2. Speed is the primary concern
3. Doing initial testing or prototyping
4. Document structure doesn't impact retrieval

For detailed strategy comparison, see [Strategies Guide](strategies.md).

## ⚙️ Configuration Guidelines

### Chunk Size Selection

| Size Range | Trade-off | Best For |
|-----------|-----------|----------|
| 256-512 tokens | Better precision, less context | Q&A, precise retrieval |
| 512-1024 tokens | Balanced | Most RAG applications |
| 1024-2048 tokens | More context, less precision | Context-heavy tasks |

**Recommended starting point:**

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 100,
  mergeSmallChunks: true,
});
```

### Content-Specific Configurations

**Knowledge Base / Documentation:**
```typescript
ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 100,
  mergeSmallChunks: true,
});
```

**Narrative / Blog Content:**
```typescript
ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,
  preferParagraphBoundaries: true,
  minChunkRatio: 0.5,
});
```

**Code Documentation / API References:**
```typescript
ChunkingService.createWithSemantic({
  maxTokens: 1024,
  minTokens: 150,
  mergeSmallChunks: true,
});
```

**Transcripts / Dialogue:**
```typescript
ChunkingService.createWithSlidingWindow({
  maxTokens: 1024,
  overlapTokens: 150,
  preferParagraphBoundaries: false,
  minChunkRatio: 0.4,
});
```

For all configuration options, see [Configuration Guide](configuration.md).

## 🔬 Advanced Techniques

### Adaptive Chunking

Choose the strategy dynamically based on content type:

```typescript
function getChunkingService(contentType: string) {
  switch (contentType) {
    case "documentation":
      return ChunkingService.createWithSemantic({
        maxTokens: 512,
        minTokens: 100,
      });

    case "blog":
      return ChunkingService.createWithSlidingWindow({
        maxTokens: 512,
        overlapTokens: 80,
        preferParagraphBoundaries: true,
      });

    case "transcript":
      return ChunkingService.createWithSlidingWindow({
        maxTokens: 1024,
        overlapTokens: 150,
      });

    default:
      return ChunkingService.createWithSemantic({
        maxTokens: 512,
        minTokens: 100,
      });
  }
}
```

### Context Enrichment

Add metadata to chunks for better retrieval:

```typescript
const chunks = await service.chunk(document);

const enrichedChunks = chunks.map((chunk) => ({
  ...chunk,
  metadata: {
    documentId: doc.id,
    documentTitle: doc.title,
    documentType: doc.type,
    chunkIndex: chunk.chunkIndex,
    totalChunks: chunks.length,
    section: extractSectionHeader(chunk.content),
  },
}));
```

### Hierarchical Chunking

Create chunks at multiple levels for different retrieval needs:

```typescript
const paragraphChunks = await semanticService.chunk(document);
const sentenceChunks = await slidingService.chunk(document);

// Paragraph chunks: main retrieval (broad context)
// Sentence chunks: precise answer extraction (narrow context)
```

### Validation and Quality Checks

```typescript
async function validateChunks(chunks: TextChunk[]) {
  for (const chunk of chunks) {
    if (chunk.tokenCount < 50) {
      console.warn(`Chunk ${chunk.chunkIndex} is too small: ${chunk.tokenCount} tokens`);
    }

    if (chunk.tokenCount > 2000) {
      console.warn(`Chunk ${chunk.chunkIndex} is too large: ${chunk.tokenCount} tokens`);
    }

    const codeBlockCount = (chunk.content.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      console.warn(`Chunk ${chunk.chunkIndex} has incomplete code block`);
    }
  }
}
```

### Caching Chunked Results

```typescript
const chunkCache = new Map<string, TextChunk[]>();

async function getChunks(documentId: string, content: string): Promise<TextChunk[]> {
  if (chunkCache.has(documentId)) {
    return chunkCache.get(documentId)!;
  }

  const chunks = await service.chunk(content);
  chunkCache.set(documentId, chunks);
  return chunks;
}
```

### A/B Testing Strategies

Test different strategies against your actual data:

```typescript
const strategies = [
  { name: "Semantic", service: ChunkingService.createWithSemantic({ maxTokens: 512, minTokens: 100 }) },
  { name: "Sliding", service: ChunkingService.createWithSlidingWindow({ maxTokens: 512, overlapTokens: 80 }) },
];

for (const { name, service } of strategies) {
  const chunks = await service.chunk(testDocument);
  const accuracy = await measureRetrievalAccuracy(chunks);
  console.log(`${name}: ${accuracy}% accuracy`);
  service.dispose();
}
```

## ❌ Common Pitfalls

| Pitfall | Problem | Solution |
|---------|---------|----------|
| **Chunks too small** | < 50 tokens lack context | Set `minTokens: 100` and `mergeSmallChunks: true` |
| **Chunks too large** | > 2000 tokens dilute relevance | Set `maxTokens: 512` (match embedding model) |
| **No overlap** | Lost context at boundaries | Use Sliding Window with `overlapTokens: 80` |
| **Splitting code blocks** | Broken code hurts understanding | Use Semantic strategy (auto-protects code) |
| **Ignoring structure** | Headers separated from content | Use Semantic strategy (preserves structure) |
| **One-size-fits-all** | Same strategy for all content | Use adaptive chunking based on content type |
| **Not validating** | Poor quality chunks hurt retrieval | Implement validation and quality checks |
| **Missing dispose()** | Memory leak from tiktoken encoder | Always call `service.dispose()` in finally block |

For detailed troubleshooting, see [Troubleshooting Guide](troubleshooting.md).

## 📊 Measuring Chunk Quality

### Metrics to Track

| Metric | Target | Why |
|--------|--------|-----|
| Average chunk size | 60-90% of maxTokens | Good utilization |
| Size variance | < 30% coefficient of variation | Consistency |
| Retrieval accuracy | Measured by eval suite | End-to-end quality |
| Processing time | < 500ms per 10KB | Acceptable latency |

### Evaluation Example

```typescript
function evaluateChunks(chunks: TextChunk[]) {
  const tokenCounts = chunks.map((c) => c.tokenCount);
  const avg = tokenCounts.reduce((a, b) => a + b, 0) / chunks.length;
  const variance = tokenCounts.reduce((sum, t) => sum + (t - avg) ** 2, 0) / tokenCounts.length;

  return {
    totalChunks: chunks.length,
    avgTokens: Math.round(avg),
    minTokens: Math.min(...tokenCounts),
    maxTokens: Math.max(...tokenCounts),
    stdDev: Math.round(Math.sqrt(variance)),
    utilization: `${(avg / 512 * 100).toFixed(1)}%`,
  };
}
```

## ✅ Essential Checklist

### Before Production

- [ ] Choose strategy based on content type
- [ ] Set `maxTokens` to match embedding model limit
- [ ] Set `minTokens` >= 100 to ensure quality
- [ ] Enable `mergeSmallChunks` for semantic strategy
- [ ] Test with representative documents
- [ ] Validate chunk quality with metrics
- [ ] Ensure `dispose()` is always called

### Ongoing

- [ ] Monitor retrieval accuracy
- [ ] A/B test strategy changes
- [ ] Profile performance with real workloads
- [ ] Review chunk quality metrics periodically

## 🔗 Further Reading

- [Pinecone: Chunking Strategies](https://www.pinecone.io/learn/chunking-strategies/)
- [OpenAI: Embeddings Best Practices](https://platform.openai.com/docs/guides/embeddings)
- [LangChain: Text Splitters](https://python.langchain.com/docs/modules/data_connection/document_transformers/)

## Related Documentation

- [Strategies Guide](strategies.md) - Detailed strategy comparison and algorithms
- [Configuration Guide](configuration.md) - All configuration options
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [Quick Start](quick-start.md) - Get started in 5 minutes
