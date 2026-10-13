# `libraries/chunking/` — Document chunking for RAG

Document chunking primitives for preparing text for embedding and Retrieval-Augmented Generation (RAG). Strategy-pattern API with three interchangeable algorithms.

> **Install via**: `ship-api add -l chunking`. Pulls in `tiktoken` for OpenAI-compatible token counts.

## Features

- **Three Chunking Strategies**:
  - **Fixed Length** — Simple, fast chunking for prototyping
  - **Sliding Window** — Overlapping chunks with intelligent boundary detection
  - **Semantic** — Structure-aware chunking (recommended for production)
- **Accurate Token Counting** — Uses tiktoken for OpenAI-compatible token counts
- **Strategy Pattern** — Swap strategies at runtime without changing client code
- **Structure-Aware** — Preserves code blocks, lists, headers, and paragraphs
- **TypeScript** — Full type safety with exported interfaces

## Quick Start

```typescript
import { ChunkingService } from "@sixthsummit/ship-api/libraries/chunking";

// Semantic chunking (recommended for production RAG)
const service = ChunkingService.createWithSemantic({
  maxTokens: 512,
  minTokens: 100,
  mergeSmallChunks: true,
});

const chunks = await service.chunk(document);

for (const chunk of chunks) {
  console.log(`Chunk ${chunk.chunkIndex}: ${chunk.tokenCount} tokens`);
  // Send to your embedding service...
}

service.dispose(); // Always clean up
```

## Strategies at a Glance

| Strategy           | Speed   | Quality | Overlap | Best For                        |
| ------------------ | ------- | ------- | ------- | ------------------------------- |
| **Fixed Length**   | Fastest | Basic   | No      | Prototyping, uniform text       |
| **Sliding Window** | Medium  | Good    | Yes     | Narrative content, articles     |
| **Semantic**       | Slower  | Best    | No      | Production RAG, structured docs |

```typescript
// Sliding Window — overlapping chunks with boundary detection
const service = ChunkingService.createWithSlidingWindow({
  maxTokens: 512,
  overlapTokens: 80,
  preferParagraphBoundaries: true,
});

// Fixed Length — simple token-based splitting
const service = ChunkingService.createWithFixedLength({
  maxTokens: 512,
});
```

## Output Format

Every strategy returns an array of `TextChunk` objects:

```typescript
interface TextChunk {
  content: string; // The text content
  startIndex: number; // Character position in original document
  endIndex: number; // End character position
  tokenCount: number; // Token count (via tiktoken)
  chunkIndex: number; // Sequential chunk number (0-indexed)
}
```

## Documentation

Comprehensive documentation is available in the [`docs/`](docs/) folder:

| Document                                           | Description                                                 |
| -------------------------------------------------- | ----------------------------------------------------------- |
| **[Quick Start](docs/quick-start.md)**             | Get started in 5 minutes                                    |
| **[Strategies Guide](docs/strategies.md)**         | Deep dive into each strategy with algorithms and comparison |
| **[API Reference](docs/api-reference.md)**         | Complete class, method, and type documentation              |
| **[Configuration](docs/configuration.md)**         | All options, tuning, and embedding model alignment          |
| **[Best Practices](docs/best-practices.md)**       | Production guidance, advanced techniques, and pitfalls      |
| **[Code Organization](docs/code-organization.md)** | Architecture, conventions, and creating custom strategies   |
| **[Troubleshooting](docs/troubleshooting.md)**     | Common issues and solutions                                 |
| **[Documentation Index](docs/index.md)**           | Full navigation hub                                         |

## Installation

Add the library to your ShipAPI project:

```bash
npx ship-api add chunking --lib
```

This installs the library files and the `tiktoken` dependency.

## Requirements

- Node.js >= 22
- tiktoken (installed automatically via CLI)
