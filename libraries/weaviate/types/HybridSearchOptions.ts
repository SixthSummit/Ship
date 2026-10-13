import type { SearchOptions } from "./SearchOptions.js";

export interface HybridSearchOptions extends SearchOptions {
  hybrid?: {
    query: string;
    alpha?: number; // 0 = pure BM25, 1 = pure vector
    properties?: string[];
    vector?: number[];
    fusionType?: "RelativeScore" | "Ranked"; // How to combine BM25 + vector scores (Weaviate values)
  };
}
