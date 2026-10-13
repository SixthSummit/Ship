# Chunking Library - Strategies Guide

Deep dive into each chunking strategy, when to use them, and how they work internally.

## 🏗️ Architecture

The chunking library uses the **Strategy pattern** to provide interchangeable chunking algorithms:

```
ChunkingService
    │
    ├── setStrategy() / constructor
    │
    └── ChunkingStrategy (interface)
            │
            ├── FixedLengthChunkingStrategy    (simple, fast)
            ├── SlidingWindowChunkingStrategy   (overlapping, boundary-aware)
            └── SemanticChunkingStrategy        (structure-aware, highest quality)
```

All strategies:
- Implement the `ChunkingStrategy` interface
- Accept text input and return `TextChunk[]`
- Use tiktoken for accurate token counting
- Provide a `dispose()` method for resource cleanup

---

## 📊 Strategy Comparison

| Feature | Fixed Length | Sliding Window | Semantic |
|---------|:-----------:|:--------------:|:--------:|
| **Speed** | ⚡ Fastest | 🔄 Medium | 🧠 Slower |
| **Quality** | Basic | Good | Best |
| **Overlap support** | ❌ | ✅ | ❌ |
| **Boundary detection** | ❌ | ✅ Sentence/paragraph | ✅ Structural |
| **Code block handling** | ❌ | ✅ Protects | ✅ Preserves |
| **List handling** | ❌ | ❌ | ✅ Preserves |
| **Header awareness** | ❌ | ❌ | ✅ Recognizes |
| **Small chunk merging** | ❌ | ❌ | ✅ Automatic |
| **Chunk size consistency** | Very consistent | Mostly consistent | Variable |
| **Best for** | Prototyping | Narrative text | Structured docs |

### Performance Benchmarks

| Strategy | 1KB | 10KB | 100KB | 1MB |
|----------|-----|------|-------|-----|
| Fixed Length | ~10ms | ~100ms | ~500ms | ~2s |
| Sliding Window | ~15ms | ~200ms | ~800ms | ~4s |
| Semantic | ~20ms | ~300ms | ~1.2s | ~6s |

> Benchmarks are approximate and vary by content type and hardware.

---

## Fixed Length Strategy

### Overview

The simplest strategy. Splits text into equal-sized chunks based purely on token count with no awareness of content structure.

### How It Works

```
Input: "The quick brown fox jumps over the lazy dog. It was a sunny day."
maxTokens: 5

Step 1: Tokenize → [The, quick, brown, fox, jumps, over, the, lazy, dog, ., It, ...]
Step 2: Split    → [The quick brown fox jumps] [over the lazy dog .] [It was a sunny day.]
Step 3: Decode   → Three chunks with character indices
```

### Algorithm

1. **Tokenize** the entire text using tiktoken
2. **Split** the token array into groups of `maxTokens`
3. **Decode** each token group back to text
4. **Calculate** character start/end indices for each chunk

### Configuration

```typescript
const service = ChunkingService.createWithFixedLength({
  maxTokens: 512,        // Required: maximum tokens per chunk
  encoding: "cl100k_base", // Optional: token encoding
});
```

### When to Use

- ✅ Quick prototyping and experimentation
- ✅ Uniform text with no structure (e.g., raw data dumps)
- ✅ Maximum speed is required
- ✅ You need consistent chunk sizes
- ❌ Structured documents (headers, lists, code)
- ❌ Narrative text where meaning matters
- ❌ Production RAG applications

### Limitations

- May split mid-sentence, mid-word, or mid-code block
- No overlap between chunks (context loss at boundaries)
- No awareness of document structure
- Poor retrieval accuracy for semantic search

---

## Sliding Window Strategy

### Overview

Creates overlapping chunks with intelligent boundary detection. Tries to end chunks at natural paragraph or sentence breaks while maintaining configurable overlap between adjacent chunks.

### How It Works

```
Input: "Paragraph one text... Paragraph two text... Paragraph three text..."
maxTokens: 100, overlapTokens: 20

Step 1: Tokenize entire text
Step 2: Create window (tokens 0-100)
Step 3: Adjust to nearest paragraph/sentence boundary
Step 4: Emit chunk 1
Step 5: Advance by stepSize (80 tokens), creating overlap
Step 6: Create window (tokens 80-180)
Step 7: Adjust boundary, emit chunk 2
...

Result: Overlapping chunks that end at natural boundaries
```

### Algorithm

1. **Tokenize** the entire text
2. **Calculate** step size: `maxTokens - overlapTokens`
3. **For each window:**
   a. Extract token window of `maxTokens` size
   b. Decode to text
   c. If not the last chunk:
      - Try to find a paragraph boundary (double newline)
      - Fall back to sentence boundary
      - Validate boundary position against `minChunkRatio`
   d. Emit the adjusted chunk
4. **Advance** by step size (creating overlap)

### Boundary Detection Details

**Paragraph boundaries** (highest priority when `preferParagraphBoundaries` is true):
- Pattern: `\n\s*\n` (double newline with optional whitespace)
- Found by scanning backward from the chunk end

**Sentence boundaries** (fallback):
- Pattern handles these edge cases:
  - Standard endings: `.`, `!`, `?` followed by space and uppercase letter
  - Abbreviations: `Dr.`, `Mr.`, `Mrs.`, `St.`, `Ph.D.` (not treated as sentence ends)
  - Decimal numbers: `3.14`, `2.5` (not treated as sentence ends)
  - URLs: `https://example.com` (not treated as sentence ends)
  - Email addresses: `user@domain.com` (not treated as sentence ends)
  - Quotations: `"Hello."` followed by new sentence
  - End of text: `.`, `!`, `?` at end of string

**Code block protection:**
- Pattern: `` ```...``` `` and `` `...` ``
- If the last 20% of a chunk is inside a code block, sentence boundary detection is skipped to avoid splitting code

**Minimum chunk ratio:**
- A boundary is only used if the resulting chunk is at least `minChunkRatio * fullChunkLength` characters
- Default: 0.5 (chunk must be at least 50% of the window)
- Prevents creating very small chunks from aggressive boundary snapping

### Configuration

```typescript
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,                    // Required: maximum tokens per chunk
  overlapTokens: 80,                 // Required: overlap between chunks
  encoding: "cl100k_base",           // Optional: token encoding
  minChunkRatio: 0.5,                // Optional: minimum chunk size ratio (0.1-0.9)
  preferParagraphBoundaries: true,   // Optional: prefer paragraph over sentence
});
```

### Overlap Explained

```
Chunk 1: [====================]
Chunk 2:             [====================]
Chunk 3:                          [====================]
                     ↑ overlap ↑           ↑ overlap ↑

The overlap region appears in both adjacent chunks, providing:
- Context continuity for embedding models
- Better retrieval for queries spanning chunk boundaries
- Reduced information loss at boundary points
```

### When to Use

- ✅ Narrative content (articles, stories, essays)
- ✅ Content where context flows across paragraphs
- ✅ Search queries that may span chunk boundaries
- ✅ Documents with natural paragraph structure
- ✅ Legal or academic documents with flowing text
- ❌ Highly structured documents (prefer Semantic)
- ❌ Maximum storage efficiency needed (overlap increases total chunks)
- ❌ Code-heavy documents (prefer Semantic)

### Overlap Recommendations

| Content Type | Recommended Overlap | Rationale |
|-------------|-------------------|-----------|
| General text | 15% (~80 of 512) | Good context with minimal redundancy |
| Legal documents | 20% (~100 of 512) | Dense text needs more context |
| Conversational | 10% (~50 of 512) | Natural turn boundaries |
| Technical docs | 15% (~80 of 512) | Balance between context and size |

---

## Semantic Strategy

### Overview

The most sophisticated strategy. Parses documents into structural semantic units (headers, paragraphs, code blocks, lists) and groups them into chunks that preserve meaning and document hierarchy. **Recommended for production RAG applications.**

### How It Works

```
Input Document:
  # Title              → header unit
  Intro paragraph...   → paragraph unit
  ## Section           → header unit
  Content...           → paragraph unit
  ```code```           → code unit (never split)
  - item 1             → list unit
  - item 2

Step 1: Parse into semantic units (in priority order)
Step 2: Group units into chunks respecting maxTokens
Step 3: Split oversized units by sentence
Step 4: Merge small chunks with neighbors
```

### Algorithm

**Phase 1 - Parse Semantic Units** (priority order):

1. **Code blocks** (highest priority - never split):
   - Pattern: `` ```[\s\S]*?``` ``
   - Extracted first to prevent other patterns from splitting them

2. **Numbered lists**:
   - Pattern: Lines starting with `\d+.\s`
   - Grouped with their continuation lines

3. **Bullet lists**:
   - Pattern: Lines starting with `-`, `*`, `+`, or `bullet`
   - Grouped with their continuation lines

4. **Headers and paragraphs** (remaining text):
   - Headers: `# Title` (ATX) or `Title\n===` (Setext)
   - Paragraphs: Text separated by blank lines
   - Processed last to handle remaining text

**Phase 2 - Group Into Chunks:**

1. Sort semantic units by document position
2. Accumulate units into the current chunk
3. When adding a unit would exceed `maxTokens`:
   - Save the current chunk
   - Start a new chunk with the current unit
4. If a single unit exceeds `maxTokens`:
   - Split it by sentence boundaries
   - Each sentence group becomes a separate chunk

**Phase 3 - Merge Small Chunks** (if `mergeSmallChunks` is true):

1. Scan through chunks sequentially
2. If a chunk has fewer than `minTokens` tokens:
   - Try to merge with the next chunk
   - Only merge if combined size is under `maxTokens`
3. Reindex chunk numbers after merging

### Configuration

```typescript
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,          // Required: maximum tokens per chunk
  minTokens: 100,          // Optional: minimum tokens (triggers merging)
  encoding: "cl100k_base", // Optional: token encoding
  mergeSmallChunks: true,  // Optional: auto-merge small chunks
});
```

### Semantic Unit Examples

**Headers:**
```markdown
# This is an ATX header        → Recognized as "header" unit
## This is also a header       → Recognized as "header" unit

This is a Setext header        → Recognized as "header" unit
====================
```

**Code blocks:**
```markdown
```python                      → Entire block is a single "code" unit
def hello():                   → (never split across chunks)
    print("Hello!")
```                            → 
```

**Lists:**
```markdown
- Item one                     → Entire list is a single "list" unit
- Item two                     → (kept together when possible)
- Item three

1. First step                  → Entire list is a "numbered_list" unit
2. Second step
3. Third step
```

**Paragraphs:**
```markdown
This is a paragraph that       → Single "paragraph" unit
contains multiple sentences.

This is another paragraph.     → Separate "paragraph" unit
```

### When to Use

- ✅ **Production RAG systems** (recommended)
- ✅ Technical documentation (markdown, structured text)
- ✅ Content with code blocks (preserves code integrity)
- ✅ Documents with headers, lists, and sections
- ✅ Knowledge base articles
- ✅ API documentation
- ✅ When retrieval accuracy matters most
- ❌ Pure narrative with no structure (Sliding Window may be better)
- ❌ Speed is the only priority (Fixed Length is faster)

---

## 🎯 Content Type Recommendations

| Content Type | Recommended Strategy | Configuration |
|-------------|---------------------|---------------|
| **Technical docs / Markdown** | Semantic | `maxTokens: 512, minTokens: 100` |
| **Blog posts / Articles** | Sliding Window | `maxTokens: 512, overlapTokens: 80` |
| **Code files** | Semantic | `maxTokens: 1024, mergeSmallChunks: true` |
| **Legal documents** | Sliding Window | `maxTokens: 512, overlapTokens: 128` |
| **Academic papers** | Semantic | `maxTokens: 512, minTokens: 150` |
| **Chat transcripts** | Fixed Length | `maxTokens: 256` |
| **Product descriptions** | Semantic | `maxTokens: 256, minTokens: 50` |
| **FAQ / Q&A** | Semantic | `maxTokens: 512, mergeSmallChunks: true` |
| **Emails / Messages** | Fixed Length | `maxTokens: 512` |
| **Mixed content** | Semantic | `maxTokens: 512, minTokens: 100` |

## 🔄 Strategy Decision Tree

```
Start
  │
  ├── Need maximum speed?
  │   └── YES → Fixed Length
  │
  ├── Content has structure? (headers, lists, code)
  │   └── YES → Semantic ⭐
  │
  ├── Content is narrative? (articles, essays, stories)
  │   ├── Need context overlap? → Sliding Window
  │   └── No overlap needed? → Semantic
  │
  ├── Just prototyping?
  │   └── YES → Fixed Length
  │
  └── Not sure?
      └── Semantic (best default) ⭐
```

## 📈 Quality vs. Speed Tradeoffs

```
Quality ▲
        │   ★ Semantic
        │  
        │         ★ Sliding Window
        │  
        │                    ★ Fixed Length
        │  
        └──────────────────────────────► Speed
```

- **Fixed Length:** Maximum throughput, minimum quality. Good for batch processing where you need results fast and can tolerate some quality loss.

- **Sliding Window:** Balanced approach. Overlap improves retrieval at chunk boundaries. Boundary detection prevents mid-sentence splits. Good general-purpose choice.

- **Semantic:** Maximum quality, slightly slower. Structure-aware chunking preserves meaning. Recommended for any application where retrieval accuracy matters.

## Related Documentation

- [API Reference](api-reference.md) - Complete class and method documentation
- [Configuration Guide](configuration.md) - Tuning options for each strategy
- [Best Practices](best-practices.md) - Production optimization
- [Quick Start](quick-start.md) - Get started quickly
