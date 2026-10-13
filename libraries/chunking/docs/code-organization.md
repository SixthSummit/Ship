# Chunking Library - Code Organization

Guide to the library's architecture, code structure, conventions, and how to extend it.

## 🏗️ Architecture

### Design Pattern: Strategy

The library is built around the **Strategy pattern**, allowing chunking algorithms to be swapped at runtime without changing the client code.

```
┌──────────────────────┐
│   ChunkingService    │     ← Client-facing service
│                      │
│  + chunk(text)       │
│  + setStrategy()     │
│  + dispose()         │
│  + static factories  │
└─────────┬────────────┘
          │ uses
          ▼
┌──────────────────────┐
│  ChunkingStrategy    │     ← Interface
│  (interface)         │
│                      │
│  + chunk(text)       │
└─────────┬────────────┘
          │ implemented by
          ▼
┌─────────────────┐  ┌──────────────────────┐  ┌────────────────────────┐
│  FixedLength     │  │  SlidingWindow        │  │  Semantic              │
│  Strategy        │  │  Strategy             │  │  Strategy              │
│                  │  │                       │  │                        │
│  Simple split    │  │  Overlap + boundaries │  │  Structure-aware       │
│  by token count  │  │  paragraph/sentence   │  │  headers/lists/code    │
└─────────────────┘  └──────────────────────┘  └────────────────────────┘
```

### Key Principles

1. **Single Responsibility:** Each strategy handles only its chunking algorithm
2. **Open/Closed:** New strategies can be added without modifying existing code
3. **Interface Segregation:** The `ChunkingStrategy` interface has a single method
4. **Dependency Inversion:** `ChunkingService` depends on the abstract interface, not concrete implementations

---

## 📁 File Structure

```
libraries/chunking/
│
├── index.ts                              # Barrel exports (all public API)
├── ChunkingService.ts                    # Main service class
├── ChunkingService.test.ts               # Service integration tests
├── ChunkingService.example.ts            # Usage examples
│
├── strategies/
│   ├── ChunkingStrategy.ts               # Base strategy interface
│   ├── FixedLengthChunkingStrategy.ts    # Fixed length implementation
│   ├── SlidingWindowChunkingStrategy.ts  # Sliding window implementation
│   ├── SlidingWindowChunkingStrategy.test.ts
│   ├── SemanticChunkingStrategy.ts       # Semantic implementation
│   └── SemanticChunkingStrategy.test.ts
│
├── types/
│   └── index.ts                          # All TypeScript type definitions
│
├── docs/
│   ├── index.md                          # Documentation index
│   ├── summary.md                        # Quick reference
│   ├── quick-start.md                    # Getting started guide
│   ├── api-reference.md                  # Complete API docs
│   ├── strategies.md                     # Strategy deep dive
│   ├── configuration.md                  # Configuration guide
│   ├── code-organization.md              # This file
│   └── troubleshooting.md               # Common issues
│
├── README.md                             # Library overview
│
├── docs/
│   ├── index.md                          # Documentation index
│   ├── summary.md                        # Quick reference
│   ├── quick-start.md                    # Getting started guide
│   ├── api-reference.md                  # Complete API docs
│   ├── strategies.md                     # Strategy deep dive
│   ├── configuration.md                  # Configuration guide
│   ├── best-practices.md                 # Production best practices
│   ├── code-organization.md              # This file
│   └── troubleshooting.md               # Common issues
```

### File Responsibilities

| File | Responsibility |
|------|---------------|
| `index.ts` | Public API surface - exports all classes, interfaces, and types |
| `ChunkingService.ts` | Service facade with factory methods and strategy delegation |
| `types/index.ts` | All TypeScript interfaces and type definitions |
| `strategies/ChunkingStrategy.ts` | Base interface contract |
| `strategies/*Strategy.ts` | Individual strategy implementations |
| `strategies/*.test.ts` | Strategy-specific unit tests |

---

## 📦 Module Exports

All public API is exported through `index.ts`:

```typescript
// Classes (concrete implementations)
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

### Import Conventions

```typescript
// Import from the library barrel (preferred)
import { ChunkingService, SemanticChunkingStrategy } from "@sixthsummit/ship-api/libraries/chunking";
import type { TextChunk, SemanticChunkingOptions } from "@sixthsummit/ship-api/libraries/chunking";

// Import specific files (internal use)
import { ChunkingStrategy } from "./strategies/ChunkingStrategy.js";
import { TextChunk } from "./types/index.js";
```

---

## 🔧 Conventions

### Naming

| Item | Convention | Example |
|------|-----------|---------|
| Strategy classes | `PascalCase` + `Strategy` suffix | `SemanticChunkingStrategy` |
| Option interfaces | `PascalCase` + `Options` suffix | `SemanticChunkingOptions` |
| Factory methods | `createWith` prefix | `createWithSemantic()` |
| Test files | Colocated, `.test.ts` suffix | `SemanticChunkingStrategy.test.ts` |
| Type files | `index.ts` in `types/` folder | `types/index.ts` |

### Strategy Implementation Pattern

Every strategy follows this pattern:

```typescript
import { encoding_for_model, get_encoding, type Tiktoken } from "tiktoken";
import { ChunkingStrategy } from "./ChunkingStrategy.js";
import { TextChunk } from "../types/index.js";

export class YourStrategy implements ChunkingStrategy {
  private encoder: Tiktoken;

  constructor(options: YourOptions) {
    // 1. Validate options
    if (/* invalid */) {
      throw new Error("Descriptive error message");
    }

    // 2. Initialize tiktoken encoder
    const encodingName = options.encoding || "cl100k_base";
    try {
      this.encoder = get_encoding(encodingName as any);
    } catch {
      this.encoder = encoding_for_model("gpt-3.5-turbo");
    }
  }

  async chunk(text: string): Promise<TextChunk[]> {
    // 3. Implement chunking algorithm
    // Always return TextChunk[] with all required fields
    return chunks;
  }

  dispose(): void {
    // 4. Clean up tiktoken encoder
    try {
      if (this.encoder) {
        this.encoder.free();
      }
    } catch {
      // Encoder may have already been freed
    }
  }
}
```

### Error Handling

- **Construction:** Validate options and throw descriptive errors
- **Encoding fallback:** If the encoding name is invalid, fall back to `gpt-3.5-turbo` silently
- **Dispose:** Catch and swallow errors during cleanup (encoder may already be freed)
- **Empty input:** Handled by `ChunkingService.chunk()` which returns `[]` for empty/whitespace text

---

## 🧪 Testing

### Test Structure

Tests are colocated with source files:

```
ChunkingService.test.ts                    # Service-level tests
strategies/SlidingWindowChunkingStrategy.test.ts  # Strategy-specific tests
strategies/SemanticChunkingStrategy.test.ts       # Strategy-specific tests
```

### Running Tests

```bash
# Run all chunking library tests
npm test -- libraries/chunking

# Run specific strategy tests
npm test -- libraries/chunking/strategies/SemanticChunkingStrategy

# Run with coverage
npm run test:coverage -- libraries/chunking

# Watch mode
npm run test:watch -- libraries/chunking
```

### Writing Tests

Follow the existing patterns:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SemanticChunkingStrategy } from "./SemanticChunkingStrategy.js";

describe("SemanticChunkingStrategy", () => {
  let strategy: SemanticChunkingStrategy;

  beforeEach(() => {
    strategy = new SemanticChunkingStrategy({
      maxTokens: 512,
      minTokens: 50,
      mergeSmallChunks: true,
    });
  });

  afterEach(() => {
    strategy.dispose();
  });

  describe("chunk", () => {
    it("should preserve code blocks", async () => {
      const text = `Some text before.

\`\`\`typescript
function hello() {
  console.log("Hello!");
}
\`\`\`

Some text after.`;

      const chunks = await strategy.chunk(text);

      // Code block should be in a single chunk
      const codeChunk = chunks.find(c => c.content.includes("function hello"));
      expect(codeChunk).toBeDefined();
      expect(codeChunk!.content).toContain("```typescript");
      expect(codeChunk!.content).toContain("```");
    });

    it("should handle empty text", async () => {
      // Note: Empty text is handled by ChunkingService, not strategies directly
      const chunks = await strategy.chunk("   ");
      // Behavior may vary by strategy
    });
  });

  describe("constructor", () => {
    it("should throw if minTokens >= maxTokens", () => {
      expect(() => {
        new SemanticChunkingStrategy({
          maxTokens: 100,
          minTokens: 100,
        });
      }).toThrow("minTokens must be less than maxTokens");
    });
  });
});
```

### Test Categories

| Category | What to Test | Example |
|----------|-------------|---------|
| **Basic functionality** | Core chunking behavior | Text splits into expected chunks |
| **Boundary handling** | Edge cases at boundaries | Sentence/paragraph detection |
| **Structure preservation** | Semantic units kept intact | Code blocks not split |
| **Configuration** | Option validation and effects | Invalid options throw errors |
| **Edge cases** | Unusual input | Empty text, single word, very long text |
| **Performance** | Processing time | Large documents complete in reasonable time |

### Mocking

To mock the chunking service in consumer code:

```typescript
import { vi } from "vitest";
import { ChunkingService } from "@sixthsummit/ship-api/libraries/chunking";
import type { TextChunk } from "@sixthsummit/ship-api/libraries/chunking";

// Mock the entire module
vi.mock("@sixthsummit/ship-api/libraries/chunking", () => ({
  ChunkingService: {
    createWithSemantic: vi.fn().mockReturnValue({
      chunk: vi.fn().mockResolvedValue([
        {
          content: "Mock chunk content",
          startIndex: 0,
          endIndex: 18,
          tokenCount: 3,
          chunkIndex: 0,
        },
      ] as TextChunk[]),
      dispose: vi.fn(),
    }),
  },
}));
```

---

## 🔌 Creating a Custom Strategy

### Step 1: Define Options Interface

Add your options to `types/index.ts`:

```typescript
export interface CustomChunkingOptions {
  maxTokens: number;
  encoding?: string;
  // Your custom options...
  customParam: string;
}
```

Update the union type:

```typescript
export type ChunkingOptions =
  | FixedLengthChunkingOptions
  | SlidingWindowChunkingOptions
  | SemanticChunkingOptions
  | CustomChunkingOptions;
```

### Step 2: Implement the Strategy

Create `strategies/CustomChunkingStrategy.ts`:

```typescript
import { encoding_for_model, get_encoding, type Tiktoken } from "tiktoken";
import { ChunkingStrategy } from "./ChunkingStrategy.js";
import { CustomChunkingOptions, TextChunk } from "../types/index.js";

export class CustomChunkingStrategy implements ChunkingStrategy {
  private encoder: Tiktoken;
  private maxTokens: number;

  constructor(options: CustomChunkingOptions) {
    this.maxTokens = options.maxTokens;

    // Validate options
    if (!options.customParam) {
      throw new Error("customParam is required");
    }

    // Initialize tokenizer
    const encodingName = options.encoding || "cl100k_base";
    try {
      this.encoder = get_encoding(encodingName as any);
    } catch {
      this.encoder = encoding_for_model("gpt-3.5-turbo");
    }
  }

  async chunk(text: string): Promise<TextChunk[]> {
    // Your chunking algorithm here
    const chunks: TextChunk[] = [];
    // ...
    return chunks;
  }

  dispose(): void {
    try {
      if (this.encoder) {
        this.encoder.free();
      }
    } catch {
      // Encoder may have already been freed
    }
  }
}
```

### Step 3: Add Factory Method

Add to `ChunkingService.ts`:

```typescript
static createWithCustom(options: CustomChunkingOptions): ChunkingService {
  const strategy = new CustomChunkingStrategy(options);
  return new ChunkingService(strategy);
}
```

Update `create()` auto-detection if applicable.

### Step 4: Export

Add to `index.ts`:

```typescript
export { CustomChunkingStrategy } from "./strategies/CustomChunkingStrategy.js";
```

### Step 5: Write Tests

Create `strategies/CustomChunkingStrategy.test.ts` covering:
- Basic chunking behavior
- Option validation
- Edge cases
- Resource cleanup

### Step 6: Document

Add the strategy to:
- `docs/strategies.md` - Strategy comparison and details
- `docs/api-reference.md` - API documentation
- `docs/configuration.md` - Configuration options
- `README.md` - Overview mention

---

## 📐 Dependencies

### Runtime Dependencies

| Package | Purpose | Usage |
|---------|---------|-------|
| `tiktoken` | Token counting and encoding | All strategies use for accurate token counting |

### Dev Dependencies

| Package | Purpose |
|---------|---------|
| `vitest` | Testing framework |
| `typescript` | Type checking and compilation |

### Why tiktoken?

- Provides the same tokenization as OpenAI's models
- Native performance (WASM-based)
- Multiple encoding support
- Accurate token counting is critical for chunk sizing
- Must be explicitly freed via `dispose()` to avoid memory leaks

---

## 🔄 Data Flow

### Chunking Pipeline

```
Input Text (string)
    │
    ▼
ChunkingService.chunk()
    │
    ├── Empty/whitespace check → return []
    │
    ▼
Strategy.chunk()
    │
    ├── Tokenize (tiktoken)
    ├── Apply strategy algorithm
    ├── Calculate character indices
    │
    ▼
TextChunk[] output
    │
    ├── content: string
    ├── startIndex: number
    ├── endIndex: number
    ├── tokenCount: number
    └── chunkIndex: number
```

### Character Index Mapping

All strategies maintain a mapping from token positions back to character positions in the original document:

```typescript
private getCharacterIndex(text: string, tokens: Uint32Array, tokenIndex: number): number {
  if (tokenIndex === 0) return 0;
  const tokensUpToIndex = tokens.slice(0, tokenIndex);
  const decoded = this.encoder.decode(tokensUpToIndex);
  return (typeof decoded === "string" ? decoded : new TextDecoder().decode(decoded)).length;
}
```

This ensures `startIndex` and `endIndex` in the output can be used to extract the exact original text:

```typescript
const originalText = document.substring(chunk.startIndex, chunk.endIndex);
// originalText should match chunk.content (may differ slightly due to trimming)
```

---

## Related Documentation

- [API Reference](api-reference.md) - Complete API docs
- [Strategies Guide](strategies.md) - Strategy details
- [Quick Start](quick-start.md) - Get started
- [Troubleshooting](troubleshooting.md) - Common issues
