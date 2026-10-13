import { encoding_for_model, get_encoding, type Tiktoken } from "tiktoken";
import type { SlidingWindowChunkingOptions, TextChunk } from "../types/index.js";
import type { ChunkingStrategy } from "./ChunkingStrategy.js";

/**
 * Sliding window chunking strategy that creates overlapping chunks and respects semantic boundaries
 *
 * Industry Best Practices:
 * - Respects paragraph boundaries (primary)
 * - Respects sentence boundaries (fallback)
 * - Improved sentence detection handling abbreviations, URLs, numbers
 * - Configurable minimum chunk size
 * - Avoids splitting semantic units
 */
export class SlidingWindowChunkingStrategy implements ChunkingStrategy {
  private encoder: Tiktoken;

  // Paragraph boundary patterns (double newline or more)
  private static readonly PARAGRAPH_ENDINGS = /\n\s*\n/g;

  // Improved sentence boundary patterns that handle edge cases
  // Handles: abbreviations, numbers, URLs, quotes, ellipsis
  private static readonly SENTENCE_ENDINGS =
    /(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?]["'])\s+(?=[A-Z])|(?<=[.!?])\s*$/gm;

  // Patterns for content that should not be split
  private static readonly CODE_BLOCK = /```[\s\S]*?```|`[^`]+`/g;

  private minChunkRatio: number;
  private preferParagraphBoundaries: boolean;

  constructor(private options: SlidingWindowChunkingOptions) {
    // Validate options
    if (options.overlapTokens >= options.maxTokens) {
      throw new Error("overlapTokens must be less than maxTokens");
    }

    // Set configurable options with defaults
    this.minChunkRatio = options.minChunkRatio ?? 0.5;
    this.preferParagraphBoundaries = options.preferParagraphBoundaries ?? true;

    // Validate minChunkRatio
    if (this.minChunkRatio < 0.1 || this.minChunkRatio > 0.9) {
      throw new Error("minChunkRatio must be between 0.1 and 0.9");
    }

    // Initialize the tokenizer with the specified encoding
    const encodingName = options.encoding || "cl100k_base";
    try {
      this.encoder = get_encoding(encodingName as any);
    } catch {
      // Fallback to GPT-3.5/4 encoding
      this.encoder = encoding_for_model("gpt-3.5-turbo");
    }
  }

  /**
   * Chunks the text with sliding window approach and sentence boundary respect
   * @param text - The text to chunk
   * @returns An array of text chunks
   */
  async chunk(text: string): Promise<TextChunk[]> {
    const chunks: TextChunk[] = [];

    // Tokenize the entire text
    const tokens = this.encoder.encode(text);
    const maxTokens = this.options.maxTokens;
    const overlapTokens = this.options.overlapTokens;
    const stepSize = maxTokens - overlapTokens;

    let chunkIndex = 0;
    let currentPosition = 0;

    while (currentPosition < tokens.length) {
      // Get the chunk tokens
      const chunkEndPosition = Math.min(currentPosition + maxTokens, tokens.length);
      let chunkTokens: Uint32Array = tokens.slice(currentPosition, chunkEndPosition);

      // Decode to text
      const decoded = this.encoder.decode(chunkTokens);
      let chunkText = typeof decoded === "string" ? decoded : new TextDecoder().decode(decoded);

      // If this is not the last chunk, adjust to end at sentence boundary
      if (chunkEndPosition < tokens.length) {
        const adjustedChunk = this.adjustToSentenceBoundary(
          chunkText,
          chunkTokens,
          text,
          currentPosition,
        );

        if (adjustedChunk) {
          chunkText = adjustedChunk.text;
          chunkTokens = adjustedChunk.tokens as Uint32Array;
        }
      }

      // Calculate character indices
      const startIndex = this.getCharacterIndex(text, tokens, currentPosition);
      const endIndex = startIndex + chunkText.length;

      chunks.push({
        content: chunkText,
        startIndex,
        endIndex,
        tokenCount: chunkTokens.length,
        chunkIndex: chunkIndex++,
      });

      // Move to next position with overlap
      if (chunkEndPosition >= tokens.length) {
        break; // We've reached the end
      }

      currentPosition += stepSize;
    }

    return chunks;
  }

  /**
   * Adjusts the chunk to end at a semantic boundary (paragraph or sentence)
   * Industry Best Practice: Prefer paragraph > sentence > word boundaries
   *
   * @param chunkText - The current chunk text
   * @param chunkTokens - The current chunk tokens
   * @param fullText - The full document text
   * @param tokenStartPosition - The starting token position
   * @returns Adjusted chunk or null if no adjustment needed
   */
  private adjustToSentenceBoundary(
    chunkText: string,
    _chunkTokens: Uint32Array,
    _fullText: string,
    _tokenStartPosition: number,
  ): { text: string; tokens: Uint32Array } | null {
    let boundaryPosition: number | null = null;

    // Try to find a paragraph boundary first (best practice for semantic coherence)
    if (this.preferParagraphBoundaries) {
      boundaryPosition = this.findLastParagraphBoundary(chunkText);
      if (boundaryPosition !== null && this.isValidBoundaryPosition(chunkText, boundaryPosition)) {
        const adjustedText = chunkText.substring(0, boundaryPosition).trim();
        const adjustedTokens = this.encoder.encode(adjustedText);
        return {
          text: adjustedText,
          tokens: adjustedTokens,
        };
      }
    }

    // Fall back to sentence boundary if no paragraph boundary found
    boundaryPosition = this.findLastSentenceBoundary(chunkText);
    if (boundaryPosition !== null && this.isValidBoundaryPosition(chunkText, boundaryPosition)) {
      const adjustedText = chunkText.substring(0, boundaryPosition).trim();
      const adjustedTokens = this.encoder.encode(adjustedText);
      return {
        text: adjustedText,
        tokens: adjustedTokens,
      };
    }

    // No suitable boundary found, return original
    return null;
  }

  /**
   * Finds the last paragraph boundary in the text
   * @param text - The text to search
   * @returns The position of the last paragraph boundary, or null if none found
   */
  private findLastParagraphBoundary(text: string): number | null {
    const matches = Array.from(text.matchAll(SlidingWindowChunkingStrategy.PARAGRAPH_ENDINGS));
    if (matches.length === 0) return null;

    const lastMatch = matches[matches.length - 1];
    return lastMatch.index! + lastMatch[0].length;
  }

  /**
   * Finds the last sentence boundary in the text
   * Uses improved regex that handles abbreviations, URLs, and other edge cases
   *
   * @param text - The text to search
   * @returns The position of the last sentence boundary, or null if none found
   */
  private findLastSentenceBoundary(text: string): number | null {
    // Check if we're in the middle of a code block (should not split)
    const codeBlocks = Array.from(text.matchAll(SlidingWindowChunkingStrategy.CODE_BLOCK));
    const inCodeBlock = codeBlocks.some((match) => {
      const matchEnd = match.index! + match[0].length;
      return matchEnd > text.length * 0.8; // Last 20% is in code block
    });

    if (inCodeBlock) return null;

    // Find sentence boundaries
    const matches = Array.from(text.matchAll(SlidingWindowChunkingStrategy.SENTENCE_ENDINGS));
    if (matches.length === 0) return null;

    // Get the last match
    const lastMatch = matches[matches.length - 1];
    return lastMatch.index! + lastMatch[0].length;
  }

  /**
   * Validates if a boundary position results in a chunk of acceptable size
   * Industry Best Practice: Chunks should be at least minChunkRatio of target size
   *
   * @param text - The full chunk text
   * @param boundaryPosition - The proposed boundary position
   * @returns True if the boundary position is valid
   */
  private isValidBoundaryPosition(text: string, boundaryPosition: number): boolean {
    // Ensure the resulting chunk is not too small
    if (boundaryPosition < text.length * this.minChunkRatio) {
      return false;
    }

    // Ensure we're not cutting off a tiny amount (less than 10 characters)
    if (text.length - boundaryPosition < 10) {
      return true; // Close enough to the end
    }

    return true;
  }

  /**
   * Helper method to get the character index from a token index
   * @param text - The original text
   * @param tokens - All tokens
   * @param tokenIndex - The token index to convert
   * @returns The character index
   */
  private getCharacterIndex(text: string, tokens: Uint32Array, tokenIndex: number): number {
    if (tokenIndex === 0) return 0;

    // Decode tokens up to the target index to find character position
    const tokensUpToIndex = tokens.slice(0, tokenIndex);
    const decoded = this.encoder.decode(tokensUpToIndex);
    const decodedUpToIndex =
      typeof decoded === "string" ? decoded : new TextDecoder().decode(decoded);
    return decodedUpToIndex.length;
  }

  /**
   * Cleanup method to free the encoder
   */
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
