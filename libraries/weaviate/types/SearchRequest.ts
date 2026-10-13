import type { BM25SearchOptions, HybridSearchOptions, VectorSearchOptions } from "./index.js";

/**
 * Discriminated union for search requests
 * This provides better type safety than method overloads
 */
export type SearchRequest =
  | {
      method: "vector";
      options: VectorSearchOptions;
    }
  | {
      method: "bm25";
      options: BM25SearchOptions;
    }
  | {
      method: "hybrid";
      options: HybridSearchOptions;
    };
