export interface VectorizerConfig {
  name: string;
  model?: string;
  dimensions?: number;
  parameters?: Record<string, any>;
}

export type Vectorizer = VectorizerConfig | "none";
