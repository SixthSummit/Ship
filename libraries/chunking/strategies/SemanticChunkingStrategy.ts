import { encoding_for_model, get_encoding, type Tiktoken } from "tiktoken";
import type { SemanticChunkingOptions, TextChunk } from "../types/index.js";
import type { ChunkingStrategy } from "./ChunkingStrategy.js";

/**
 * Semantic chunking strategy that creates chunks based on document structure
 *
 * Industry Best Practices Implemented:
 * - Content-aware chunking using document structure
 * - Preserves semantic units (paragraphs, sections, lists)
 * - Handles code blocks, headers, and lists specially
 * - Merges small chunks to avoid fragmentation
 * - Maintains context through structural boundaries
 *
 * This approach is superior for RAG and embedding applications as it:
 * - Preserves meaning and context better than fixed-size chunking
 * - Avoids splitting related content
 * - Improves retrieval accuracy
 * - Maintains document hierarchy
 */
export class SemanticChunkingStrategy implements ChunkingStrategy {
  private encoder: Tiktoken;
  private maxTokens: number;
  private minTokens: number;
  private mergeSmallChunks: boolean;

  // Document structure patterns
  private static readonly HEADER_PATTERN = /^#{1,6}\s+.+$|^.+\n[=-]{3,}$/gm;
  private static readonly PARAGRAPH_BREAK = /\n\s*\n/g;
  private static readonly CODE_BLOCK = /```[\s\S]*?```/g;
  private static readonly LIST_PATTERN =
    /(?:^|\n)(?:[\s]*[-*+•]\s+.+(?:\n(?![\s]*[-*+•]\s+).+)*)+/gm;
  private static readonly NUMBERED_LIST =
    /(?:^|\n)(?:[\s]*\d+\.\s+.+(?:\n(?![\s]*\d+\.\s+).+)*)+/gm;

  constructor(options: SemanticChunkingOptions) {
    this.maxTokens = options.maxTokens;
    this.minTokens = options.minTokens ?? 100;
    this.mergeSmallChunks = options.mergeSmallChunks ?? true;

    // Validate options
    if (this.minTokens >= this.maxTokens) {
      throw new Error("minTokens must be less than maxTokens");
    }

    // Initialize the tokenizer
    const encodingName = options.encoding || "cl100k_base";
    try {
      this.encoder = get_encoding(encodingName as any);
    } catch {
      this.encoder = encoding_for_model("gpt-3.5-turbo");
    }
  }

  /**
   * Chunks the text based on semantic/structural boundaries
   * @param text - The text to chunk
   * @returns An array of semantically coherent chunks
   */
  async chunk(text: string): Promise<TextChunk[]> {
    // Parse the document into semantic units
    const semanticUnits = this.parseSemanticUnits(text);

    // Group semantic units into chunks
    const chunks = this.groupIntoChunks(semanticUnits, text);

    return chunks;
  }

  /**
   * Parses the document into semantic units (paragraphs, headers, code blocks, lists)
   * @param text - The text to parse
   * @returns Array of semantic units with their positions
   */
  private parseSemanticUnits(
    text: string,
  ): Array<{ content: string; startIndex: number; endIndex: number; type: string }> {
    const units: Array<{ content: string; startIndex: number; endIndex: number; type: string }> =
      [];

    // Track which parts of text have been processed
    const processed = new Array(text.length).fill(false);

    // Extract code blocks first (highest priority to avoid splitting)
    const codeBlocks = Array.from(text.matchAll(SemanticChunkingStrategy.CODE_BLOCK));
    for (const match of codeBlocks) {
      const startIndex = match.index!;
      const content = match[0];
      const endIndex = startIndex + content.length;

      units.push({
        content,
        startIndex,
        endIndex,
        type: "code",
      });

      // Mark as processed
      for (let i = startIndex; i < endIndex; i++) {
        processed[i] = true;
      }
    }

    // Extract numbered lists
    const numberedLists = Array.from(text.matchAll(SemanticChunkingStrategy.NUMBERED_LIST));
    for (const match of numberedLists) {
      const startIndex = match.index!;
      const content = match[0];
      const endIndex = startIndex + content.length;

      // Check if already processed (e.g., in code block)
      if (!processed[startIndex]) {
        units.push({
          content: content.trim(),
          startIndex,
          endIndex,
          type: "numbered_list",
        });

        for (let i = startIndex; i < endIndex; i++) {
          processed[i] = true;
        }
      }
    }

    // Extract bullet lists
    const lists = Array.from(text.matchAll(SemanticChunkingStrategy.LIST_PATTERN));
    for (const match of lists) {
      const startIndex = match.index!;
      const content = match[0];
      const endIndex = startIndex + content.length;

      if (!processed[startIndex]) {
        units.push({
          content: content.trim(),
          startIndex,
          endIndex,
          type: "list",
        });

        for (let i = startIndex; i < endIndex; i++) {
          processed[i] = true;
        }
      }
    }

    // Split remaining text by paragraphs
    let currentIndex = 0;
    const paragraphs = text.split(SemanticChunkingStrategy.PARAGRAPH_BREAK);

    for (const paragraph of paragraphs) {
      const startIndex = text.indexOf(paragraph, currentIndex);
      if (startIndex === -1) continue;

      const endIndex = startIndex + paragraph.length;

      // Check if this paragraph is already processed
      const alreadyProcessed = processed.slice(startIndex, endIndex).some((p) => p);

      if (!alreadyProcessed && paragraph.trim().length > 0) {
        // Check if it's a header
        const isHeader = SemanticChunkingStrategy.HEADER_PATTERN.test(paragraph);

        units.push({
          content: paragraph.trim(),
          startIndex,
          endIndex,
          type: isHeader ? "header" : "paragraph",
        });

        for (let i = startIndex; i < endIndex; i++) {
          processed[i] = true;
        }
      }

      currentIndex = endIndex;
    }

    // Sort by start index
    return units.sort((a, b) => a.startIndex - b.startIndex);
  }

  /**
   * Groups semantic units into chunks that respect token limits
   * @param units - The semantic units to group
   * @param fullText - The full document text
   * @returns Array of text chunks
   */
  private groupIntoChunks(
    units: Array<{ content: string; startIndex: number; endIndex: number; type: string }>,
    fullText: string,
  ): TextChunk[] {
    const chunks: TextChunk[] = [];
    let currentChunk: string[] = [];
    let currentTokenCount = 0;
    let chunkStartIndex = 0;
    let chunkIndex = 0;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const unitTokens = this.encoder.encode(unit.content).length;

      // If this unit alone exceeds maxTokens, split it
      if (unitTokens > this.maxTokens) {
        // Save current chunk if not empty
        if (currentChunk.length > 0) {
          const chunkContent = currentChunk.join("\n\n");
          chunks.push({
            content: chunkContent,
            startIndex: chunkStartIndex,
            endIndex: chunkStartIndex + chunkContent.length,
            tokenCount: currentTokenCount,
            chunkIndex: chunkIndex++,
          });
          currentChunk = [];
          currentTokenCount = 0;
        }

        // Split the large unit
        const subChunks = this.splitLargeUnit(unit, fullText);
        subChunks.forEach((subChunk) => {
          chunks.push({
            ...subChunk,
            chunkIndex: chunkIndex++,
          });
        });

        chunkStartIndex = unit.endIndex;
        continue;
      }

      // Check if adding this unit would exceed maxTokens
      if (currentTokenCount + unitTokens > this.maxTokens && currentChunk.length > 0) {
        // Save current chunk
        const chunkContent = currentChunk.join("\n\n");
        chunks.push({
          content: chunkContent,
          startIndex: chunkStartIndex,
          endIndex: chunkStartIndex + chunkContent.length,
          tokenCount: currentTokenCount,
          chunkIndex: chunkIndex++,
        });

        // Start new chunk
        currentChunk = [unit.content];
        currentTokenCount = unitTokens;
        chunkStartIndex = unit.startIndex;
      } else {
        // Add to current chunk
        if (currentChunk.length === 0) {
          chunkStartIndex = unit.startIndex;
        }
        currentChunk.push(unit.content);
        currentTokenCount += unitTokens;
      }
    }

    // Add final chunk
    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join("\n\n");
      chunks.push({
        content: chunkContent,
        startIndex: chunkStartIndex,
        endIndex: chunkStartIndex + chunkContent.length,
        tokenCount: currentTokenCount,
        chunkIndex: chunkIndex++,
      });
    }

    // Merge small chunks if enabled
    if (this.mergeSmallChunks) {
      return this.mergeSmallChunksInternal(chunks);
    }

    return chunks;
  }

  /**
   * Splits a large semantic unit into smaller chunks
   * @param unit - The unit to split
   * @param fullText - The full document text
   * @returns Array of chunks
   */
  private splitLargeUnit(
    unit: { content: string; startIndex: number; endIndex: number; type: string },
    _fullText: string,
  ): Omit<TextChunk, "chunkIndex">[] {
    const chunks: Omit<TextChunk, "chunkIndex">[] = [];

    // Split by sentences for large units
    const sentences = unit.content.split(/(?<=[.!?])\s+/);
    let currentChunk: string[] = [];
    let currentTokenCount = 0;
    let sentenceStartIndex = unit.startIndex;

    for (const sentence of sentences) {
      const sentenceTokens = this.encoder.encode(sentence).length;

      if (currentTokenCount + sentenceTokens > this.maxTokens && currentChunk.length > 0) {
        const chunkContent = currentChunk.join(" ");
        chunks.push({
          content: chunkContent,
          startIndex: sentenceStartIndex,
          endIndex: sentenceStartIndex + chunkContent.length,
          tokenCount: currentTokenCount,
        });

        currentChunk = [sentence];
        currentTokenCount = sentenceTokens;
        sentenceStartIndex += chunkContent.length + 1;
      } else {
        currentChunk.push(sentence);
        currentTokenCount += sentenceTokens;
      }
    }

    if (currentChunk.length > 0) {
      const chunkContent = currentChunk.join(" ");
      chunks.push({
        content: chunkContent,
        startIndex: sentenceStartIndex,
        endIndex: sentenceStartIndex + chunkContent.length,
        tokenCount: currentTokenCount,
      });
    }

    return chunks;
  }

  /**
   * Merges small chunks with adjacent chunks to avoid fragmentation
   * Industry Best Practice: Avoid chunks smaller than minTokens
   *
   * @param chunks - The chunks to merge
   * @returns Merged chunks
   */
  private mergeSmallChunksInternal(chunks: TextChunk[]): TextChunk[] {
    if (chunks.length <= 1) return chunks;

    const merged: TextChunk[] = [];
    let i = 0;

    while (i < chunks.length) {
      const chunk = chunks[i];

      // If chunk is too small and not the last one, try to merge with next
      if (chunk.tokenCount < this.minTokens && i < chunks.length - 1) {
        const nextChunk = chunks[i + 1];
        const combinedTokenCount = chunk.tokenCount + nextChunk.tokenCount;

        // Merge if combined size is acceptable
        if (combinedTokenCount <= this.maxTokens) {
          const mergedContent = `${chunk.content}\n\n${nextChunk.content}`;
          merged.push({
            content: mergedContent,
            startIndex: chunk.startIndex,
            endIndex: nextChunk.endIndex,
            tokenCount: combinedTokenCount,
            chunkIndex: merged.length,
          });
          i += 2; // Skip both chunks
          continue;
        }
      }

      // Add chunk as is
      merged.push({
        ...chunk,
        chunkIndex: merged.length,
      });
      i++;
    }

    return merged;
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
