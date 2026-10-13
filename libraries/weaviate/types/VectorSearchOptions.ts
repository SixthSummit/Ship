import type { SearchOptions } from "./SearchOptions.js";

export interface VectorSearchOptions extends SearchOptions {
  nearText?: {
    concepts: string[];
    certainty?: number;
    moveAwayFrom?: { concepts: string[]; force: number };
    moveTo?: { concepts: string[]; force: number };
  };
  nearVector?: {
    vector: number[];
    certainty?: number;
  };
  nearObject?: {
    id: string;
    certainty?: number;
  };
}
