import type { SearchResult } from "./SearchResult.js";

export interface SearchMethod {
  name: string;
  description: string;
  supportedOptions: string[];
  execute: (className: string, options: any) => Promise<SearchResult>;
}
