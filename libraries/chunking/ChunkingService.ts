import type { ChunkingStrategy } from "./strategies/ChunkingStrategy.js";
import { FixedLengthChunkingStrategy } from "./strategies/FixedLengthChunkingStrategy.js";
import { SemanticChunkingStrategy } from "./strategies/SemanticChunkingStrategy.js";
import { SlidingWindowChunkingStrategy } from "./strategies/SlidingWindowChunkingStrategy.js";
import type {
  ChunkingOptions,
  FixedLengthChunkingOptions,
  SemanticChunkingOptions,
  SlidingWindowChunkingOptions,
  TextChunk,
} from "./types/index.js";

/**
 * Service for chunking documents for embedding using various strategies
 */
export class ChunkingService {
  private strategy: ChunkingStrategy;

  /**
   * Creates a new ChunkingService with the specified strategy
   * @param strategy - The chunking strategy to use
   */
  constructor(strategy: ChunkingStrategy) {
    this.strategy = strategy;
  }

  /**
   * Chunks the given text using the configured strategy
   * @param text - The text to chunk
   * @returns An array of text chunks
   */
  async chunk(text: string): Promise<TextChunk[]> {
    if (!text || text.trim().length === 0) {
      return [];
    }

    return await this.strategy.chunk(text);
  }

  /**
   * Sets a new chunking strategy
   * @param strategy - The new strategy to use
   */
  setStrategy(strategy: ChunkingStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Factory method to create a ChunkingService with fixed length strategy
   * @param options - Configuration options for fixed length chunking
   * @returns A new ChunkingService instance
   */
  static createWithFixedLength(options: FixedLengthChunkingOptions): ChunkingService {
    const strategy = new FixedLengthChunkingStrategy(options);
    return new ChunkingService(strategy);
  }

  /**
   * Factory method to create a ChunkingService with sliding window strategy
   * @param options - Configuration options for sliding window chunking
   * @returns A new ChunkingService instance
   */
  static createWithSlidingWindow(options: SlidingWindowChunkingOptions): ChunkingService {
    const strategy = new SlidingWindowChunkingStrategy(options);
    return new ChunkingService(strategy);
  }

  /**
   * Factory method to create a ChunkingService with semantic strategy
   * Industry Best Practice: Use for RAG and embedding applications requiring semantic coherence
   *
   * @param options - Configuration options for semantic chunking
   * @returns A new ChunkingService instance
   */
  static createWithSemantic(options: SemanticChunkingOptions): ChunkingService {
    const strategy = new SemanticChunkingStrategy(options);
    return new ChunkingService(strategy);
  }

  /**
   * Factory method to create a ChunkingService with the appropriate strategy based on options
   * @param options - Configuration options for chunking
   * @returns A new ChunkingService instance
   */
  static create(options: ChunkingOptions): ChunkingService {
    if ("overlapTokens" in options) {
      return ChunkingService.createWithSlidingWindow(options);
    } else if ("minTokens" in options || "mergeSmallChunks" in options) {
      return ChunkingService.createWithSemantic(options as SemanticChunkingOptions);
    } else {
      return ChunkingService.createWithFixedLength(options);
    }
  }

  /**
   * Cleanup method to dispose of the strategy if needed
   */
  dispose(): void {
    if ("dispose" in this.strategy && typeof this.strategy.dispose === "function") {
      (this.strategy as any).dispose();
    }
  }
}
