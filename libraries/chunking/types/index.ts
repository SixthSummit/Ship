/**
 * Represents a chunk of text with metadata
 */
export interface TextChunk {
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

/**
 * Configuration options for fixed length chunking
 */
export interface FixedLengthChunkingOptions {
  /** The maximum number of tokens per chunk */
  maxTokens: number;
  /** The encoding to use for token counting (default: 'cl100k_base' for GPT-3.5/4) */
  encoding?: string;
}

/**
 * Configuration options for sliding window chunking
 */
export interface SlidingWindowChunkingOptions {
  /** The maximum number of tokens per chunk */
  maxTokens: number;
  /** The number of overlapping tokens between chunks */
  overlapTokens: number;
  /** The encoding to use for token counting (default: 'cl100k_base' for GPT-3.5/4) */
  encoding?: string;
  /** Minimum chunk size as a ratio of maxTokens (default: 0.5 = 50%) */
  minChunkRatio?: number;
  /** Prefer paragraph boundaries over sentence boundaries (default: true) */
  preferParagraphBoundaries?: boolean;
}

/**
 * Configuration options for semantic chunking
 */
export interface SemanticChunkingOptions {
  /** The maximum number of tokens per chunk */
  maxTokens: number;
  /** The minimum number of tokens per chunk (default: 100) */
  minTokens?: number;
  /** The encoding to use for token counting (default: 'cl100k_base') */
  encoding?: string;
  /** Whether to merge small chunks with adjacent chunks (default: true) */
  mergeSmallChunks?: boolean;
}

/**
 * Union type for all chunking options
 */
export type ChunkingOptions =
  | FixedLengthChunkingOptions
  | SlidingWindowChunkingOptions
  | SemanticChunkingOptions;
