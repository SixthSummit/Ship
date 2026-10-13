export interface SearchResult<T = any> {
  objects: Array<{
    id: string;
    properties: T;
    vector?: number[];
    certainty?: number;
    distance?: number;
    score?: number;
    metadata?: {
      explainScore?: string;
      [key: string]: any;
    };
  }>;
  total?: number;
  took?: number;
}
