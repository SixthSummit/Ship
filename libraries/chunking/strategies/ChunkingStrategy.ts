import type { TextChunk } from "../types/index.js";

/**
 * Base interface for all chunking strategies
 */
export interface ChunkingStrategy {
  /**
   * Chunks the given text according to the strategy
   * @param text - The text to chunk
   * @returns An array of text chunks
   */
  chunk(text: string): Promise<TextChunk[]>;
}
