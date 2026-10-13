# Chunking Library - API Reference

Complete API documentation for the chunking library.

## ChunkingService

The main entry point for document chunking. Uses the Strategy pattern to delegate chunking logic to pluggable strategy implementations.

### Constructor

```typescript
constructor(strategy: ChunkingStrategy)
```

Creates a new `ChunkingService` with the specified strategy.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `strategy` | `ChunkingStrategy` | The chunking strategy implementation to use |

**Example:**
```typescript
const strategy = new SemanticChunkingStrategy({ maxTokens: 512 });
const service = new ChunkingService(strategy);
```

---

### chunk()

```typescript
async chunk(text: string): Promise<TextChunk[]>
```

Chunks the given text using the configured strategy.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | `string` | The text to chunk |

**Returns:** `Promise<TextChunk[]>` - Array of text chunks

**Behavior:**
- Returns an empty array if `text` is empty, null, or contains only whitespace
- Delegates to the configured strategy for actual chunking
- All strategies are async-compatible

**Example:**
```typescript
const chunks = await service.chunk(documentText);

for (const chunk of chunks) {
  console.log(`Chunk ${chunk.chunkIndex}: ${chunk.tokenCount} tokens`);
  console.log(chunk.content);
}
```

---

### setStrategy()

```typescript
setStrategy(strategy: ChunkingStrategy): void
```

Replaces the current chunking strategy at runtime.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `strategy` | `ChunkingStrategy` | The new strategy to use |

**Example:**
```typescript
// Start with semantic
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
const structuredChunks = await service.chunk(markdownDoc);

// Switch to sliding window for different content
service.setStrategy(
  new SlidingWindowChunkingStrategy({ maxTokens: 512, overlapTokens: 80 })
);
const narrativeChunks = await service.chunk(articleText);
```

> **Note:** The previous strategy is not automatically disposed. If you need to free resources, call `dispose()` before switching, or dispose the old strategy manually.

---

### dispose()

```typescript
dispose(): void
```

Cleans up resources held by the current strategy (primarily the tiktoken encoder).

**Important:** Always call `dispose()` when you're done with the service to free the native tiktoken encoder memory.

**Example:**
```typescript
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });

try {
  const chunks = await service.chunk(text);
  // Process chunks...
} finally {
  service.dispose();
}
```

---

## Static Factory Methods

### static createWithFixedLength()

```typescript
static createWithFixedLength(options: FixedLengthChunkingOptions): ChunkingService
```

Creates a `ChunkingService` with the Fixed Length strategy.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `FixedLengthChunkingOptions` | Configuration options |

**Example:**
```typescript
const service = ChunkingService.createWithFixedLength({
  maxTokens: 512,
  encoding: "cl100k_base",
});
```

---

### static createWithSlidingWindow()

```typescript
static createWithSlidingWindow(options: SlidingWindowChunkingOptions): ChunkingService
```

Creates a `ChunkingService` with the Sliding Window strategy.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `SlidingWindowChunkingOptions` | Configuration options |

**Example:**
```typescript
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,
  preferParagraphBoundaries: true,
  minChunkRatio: 0.5,
});
```

---

### static createWithSemantic()

```typescript
static createWithSemantic(options: SemanticChunkingOptions): ChunkingService
```

Creates a `ChunkingService` with the Semantic strategy. **Recommended for production RAG applications.**

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `SemanticChunkingOptions` | Configuration options |

**Example:**
```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 100,
  mergeSmallChunks: true,
});
```

---

### static create()

```typescript
static create(options: ChunkingOptions): ChunkingService
```

Auto-detects the appropriate strategy based on which options are provided.

**Detection Logic:**

| Options Present | Strategy Selected |
|-----------------|-------------------|
| `overlapTokens` | Sliding Window |
| `minTokens` or `mergeSmallChunks` | Semantic |
| Only `maxTokens` | Fixed Length |

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `ChunkingOptions` | Configuration options (union type) |

**Example:**
```typescript
// Auto-detects Sliding Window
const sw = ChunkingService.create({ maxTokens: 512, overlapTokens: 80 });

// Auto-detects Semantic
const sem = ChunkingService.create({ maxTokens: 512, minTokens: 100 });

// Auto-detects Fixed Length
const fl = ChunkingService.create({ maxTokens: 512 });
```

---

## Strategy Interfaces

### ChunkingStrategy

Base interface that all chunking strategies must implement.

```typescript
interface ChunkingStrategy {
  chunk(text: string): Promise<TextChunk[]>;
}
```

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `chunk` | `text: string` | `Promise<TextChunk[]>` | Chunks the text according to the strategy |

---

## Strategy Implementations

### FixedLengthChunkingStrategy

Splits text into non-overlapping chunks of a specified token count.

```typescript
class FixedLengthChunkingStrategy implements ChunkingStrategy {
  constructor(options: FixedLengthChunkingOptions);
  chunk(text: string): Promise<TextChunk[]>;
  dispose(): void;
}
```

**Algorithm:**
1. Tokenize entire text using tiktoken
2. Split tokens into groups of `maxTokens`
3. Decode each group back to text
4. Calculate character indices

**Characteristics:**
- Fastest strategy (~100-200ms per 10KB)
- Precise token counting
- No overlap between chunks
- May split mid-sentence or mid-word

---

### SlidingWindowChunkingStrategy

Creates overlapping chunks with intelligent boundary detection.

```typescript
class SlidingWindowChunkingStrategy implements ChunkingStrategy {
  constructor(options: SlidingWindowChunkingOptions);
  chunk(text: string): Promise<TextChunk[]>;
  dispose(): void;
}
```

**Constructor Validation:**
- Throws `Error` if `overlapTokens >= maxTokens`
- Throws `Error` if `minChunkRatio` is outside 0.1-0.9 range

**Algorithm:**
1. Tokenize text
2. Create windows with `stepSize = maxTokens - overlapTokens`
3. For each window:
   - Try to end at paragraph boundary (if `preferParagraphBoundaries`)
   - Fall back to sentence boundary
   - Validate against `minChunkRatio`
   - Protect code blocks from splitting
4. Return overlapping chunks

**Boundary Detection:**
- **Paragraphs:** Double newlines (`\n\s*\n`)
- **Sentences:** Handles abbreviations (Dr., Mr., Mrs., Ph.D.), decimal numbers, URLs, email addresses, quotation marks, ellipsis

**Characteristics:**
- Medium speed (~150-300ms per 10KB)
- Configurable overlap for context preservation
- Respects paragraph and sentence boundaries
- Protects code blocks from splitting

---

### SemanticChunkingStrategy

Structure-aware chunking that preserves document semantics.

```typescript
class SemanticChunkingStrategy implements ChunkingStrategy {
  constructor(options: SemanticChunkingOptions);
  chunk(text: string): Promise<TextChunk[]>;
  dispose(): void;
}
```

**Constructor Validation:**
- Throws `Error` if `minTokens >= maxTokens`

**Algorithm:**
1. **Parse** document into semantic units (priority order):
   - Code blocks (fenced with triple backticks)
   - Numbered lists
   - Bullet lists (-, *, +, bullet)
   - Headers (ATX `#` and Setext `===`/`---`)
   - Paragraphs
2. **Group** units into chunks respecting `maxTokens`
   - If a single unit exceeds `maxTokens`, split it by sentences
3. **Merge** small chunks (if `mergeSmallChunks` enabled)
   - Chunks under `minTokens` are combined with adjacent chunks

**Recognized Structures:**

| Structure | Pattern | Priority |
|-----------|---------|----------|
| Code blocks | `` ```...``` `` | Highest (never split) |
| Numbered lists | `1. item\n2. item` | High |
| Bullet lists | `- item\n- item` | High |
| Headers | `# Title` or `Title\n===` | Medium |
| Paragraphs | Text separated by blank lines | Normal |

**Characteristics:**
- Highest quality output
- Slower (~200-400ms per 10KB)
- Preserves document hierarchy and meaning
- Automatic small chunk merging
- Best for RAG retrieval accuracy

---

## Type Definitions

### TextChunk

The output type for all chunking operations.

```typescript
interface TextChunk {
  /** The text content of the chunk */
  content: string;
  /** The starting character index in the original document */
  startIndex: number;
  /** The ending character index in the original document */
  endIndex: number;
  /** The token count of the chunk */
  tokenCount: number;
  /** The chunk number (0-indexed) */
  chunkIndex: number;
}
```

| Property | Type | Description |
|----------|------|-------------|
| `content` | `string` | The actual text content |
| `startIndex` | `number` | Character position where this chunk starts in the original document |
| `endIndex` | `number` | Character position where this chunk ends in the original document |
| `tokenCount` | `number` | Number of tokens in this chunk (using configured encoding) |
| `chunkIndex` | `number` | Sequential chunk number, starting from 0 |

---

### FixedLengthChunkingOptions

```typescript
interface FixedLengthChunkingOptions {
  /** The maximum number of tokens per chunk */
  maxTokens: number;
  /** The encoding to use for token counting (default: 'cl100k_base') */
  encoding?: string;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `maxTokens` | `number` | Yes | - | Maximum tokens per chunk |
| `encoding` | `string` | No | `'cl100k_base'` | Token encoding name |

---

### SlidingWindowChunkingOptions

```typescript
interface SlidingWindowChunkingOptions {
  /** The maximum number of tokens per chunk */
  maxTokens: number;
  /** The number of overlapping tokens between chunks */
  overlapTokens: number;
  /** The encoding to use for token counting (default: 'cl100k_base') */
  encoding?: string;
  /** Minimum chunk size as a ratio of maxTokens (default: 0.5) */
  minChunkRatio?: number;
  /** Prefer paragraph boundaries over sentence boundaries (default: true) */
  preferParagraphBoundaries?: boolean;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `maxTokens` | `number` | Yes | - | Maximum tokens per chunk |
| `overlapTokens` | `number` | Yes | - | Tokens overlapping between adjacent chunks |
| `encoding` | `string` | No | `'cl100k_base'` | Token encoding name |
| `minChunkRatio` | `number` | No | `0.5` | Minimum chunk size ratio (0.1 - 0.9) |
| `preferParagraphBoundaries` | `boolean` | No | `true` | Try paragraph boundaries before sentence |

**Constraints:**
- `overlapTokens` must be less than `maxTokens`
- `minChunkRatio` must be between 0.1 and 0.9

---

### SemanticChunkingOptions

```typescript
interface SemanticChunkingOptions {
  /** The maximum number of tokens per chunk */
  maxTokens: number;
  /** The minimum number of tokens per chunk (default: 100) */
  minTokens?: number;
  /** The encoding to use for token counting (default: 'cl100k_base') */
  encoding?: string;
  /** Whether to merge small chunks with adjacent chunks (default: true) */
  mergeSmallChunks?: boolean;
}
```

| Property | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `maxTokens` | `number` | Yes | - | Maximum tokens per chunk |
| `minTokens` | `number` | No | `100` | Minimum tokens per chunk |
| `encoding` | `string` | No | `'cl100k_base'` | Token encoding name |
| `mergeSmallChunks` | `boolean` | No | `true` | Auto-merge chunks below minTokens |

**Constraints:**
- `minTokens` must be less than `maxTokens`

---

### ChunkingOptions

Union type for all option interfaces. Used with `ChunkingService.create()` for auto-detection.

```typescript
type ChunkingOptions =
  | FixedLengthChunkingOptions
  | SlidingWindowChunkingOptions
  | SemanticChunkingOptions;
```

---

## Exports

All public types and classes are exported from the library's main `index.ts`:

```typescript
// Classes
export { ChunkingService } from "./ChunkingService.js";
export { FixedLengthChunkingStrategy } from "./strategies/FixedLengthChunkingStrategy.js";
export { SlidingWindowChunkingStrategy } from "./strategies/SlidingWindowChunkingStrategy.js";
export { SemanticChunkingStrategy } from "./strategies/SemanticChunkingStrategy.js";

// Interfaces
export type { ChunkingStrategy } from "./strategies/ChunkingStrategy.js";

// Types
export type {
  TextChunk,
  ChunkingOptions,
  FixedLengthChunkingOptions,
  SlidingWindowChunkingOptions,
  SemanticChunkingOptions,
} from "./types/index.js";
```

---

## Error Handling

### Construction Errors

| Error | Cause | Strategy |
|-------|-------|----------|
| `overlapTokens must be less than maxTokens` | `overlapTokens >= maxTokens` | Sliding Window |
| `minChunkRatio must be between 0.1 and 0.9` | Out of range ratio | Sliding Window |
| `minTokens must be less than maxTokens` | `minTokens >= maxTokens` | Semantic |

### Runtime Behavior

| Scenario | Behavior |
|----------|----------|
| Empty or whitespace-only text | Returns `[]` (empty array) |
| Invalid encoding name | Falls back to `gpt-3.5-turbo` encoding |
| Text shorter than `maxTokens` | Returns single chunk |
| Single semantic unit exceeds `maxTokens` | Split by sentences (Semantic) |

### Resource Cleanup

```typescript
// Always dispose to free native resources
const service = ChunkingService.createWithSemantic({ maxTokens: 512 });
try {
  const chunks = await service.chunk(text);
  return chunks;
} finally {
  service.dispose();
}
```

> **Warning:** Failing to call `dispose()` will leak the tiktoken encoder's native memory. In long-running applications, always use try/finally or equivalent cleanup patterns.

---

## Related Documentation

- [Quick Start Guide](quick-start.md)
- [Strategies Guide](strategies.md)
- [Configuration Guide](configuration.md)
- [Troubleshooting](troubleshooting.md)
