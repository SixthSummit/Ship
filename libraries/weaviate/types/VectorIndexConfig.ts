export interface VectorIndexConfig {
  distance?: "cosine" | "dot" | "l2-squared" | "hamming" | "manhattan";
  ef?: number;
  efConstruction?: number;
  maxConnections?: number;
  efSearch?: number;
  skip?: boolean;
  cleanupIntervalSeconds?: number;
  pq?: {
    enabled?: boolean;
    segments?: number;
    centroids?: number;
    trainingLimit?: number;
    encoder?: {
      type?: string;
      distribution?: string;
    };
  };
}
