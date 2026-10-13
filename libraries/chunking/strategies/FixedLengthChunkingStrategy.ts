import { encoding_for_model, get_encoding, type Tiktoken } from "tiktoken";
import type { FixedLengthChunkingOptions, TextChunk } from "../types/index.js";
import type { ChunkingStrategy } from "./ChunkingStrategy.js";

/**
 * Fixed length chunking strategy that splits text into chunks of a specified token count
 */
export class FixedLengthChunkingStrategy implements ChunkingStrategy {
  private encoder: Tiktoken;

  constructor(private options: FixedLengthChunkingOptions) {
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
   * Chunks the text into fixed-length chunks based on token count
   * @param text - The text to chunk
   * @returns An array of text chunks
   */
  async chunk(text: string): Promise<TextChunk[]> {
    const chunks: TextChunk[] = [];

    // Tokenize the entire text
    const tokens = this.encoder.encode(text);
    const maxTokens = this.options.maxTokens;

    // Split into chunks
    let chunkIndex = 0;
    for (let i = 0; i < tokens.length; i += maxTokens) {
      const chunkTokens = tokens.slice(i, i + maxTokens);
      const decoded = this.encoder.decode(chunkTokens);
      // Ensure we have a proper string
      const chunkText = typeof decoded === "string" ? decoded : new TextDecoder().decode(decoded);

      // Calculate character indices
      const startIndex = this.getCharacterIndex(text, tokens, i);
      const endIndex = startIndex + chunkText.length;

      chunks.push({
        content: chunkText,
        startIndex,
        endIndex,
        tokenCount: chunkTokens.length,
        chunkIndex: chunkIndex++,
      });
    }

    return chunks;
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
