import type { SearchOptions } from "./SearchOptions.js";

export interface BM25SearchOptions extends SearchOptions {
  bm25?: {
    query: string;
    properties?: string[];
    boost?: number;
  };
}
