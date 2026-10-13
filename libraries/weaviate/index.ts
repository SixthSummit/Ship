// Main Weaviate framework exports

// Errors
export { WeaviateError, WeaviateErrorCode } from "./errors/index.js";
// Query builder and utilities
export { createQueryBuilder, QueryBuilder, QueryPatterns } from "./QueryBuilder.js";
// Schema system
export { default as SchemaRegistry } from "./schemas/SchemaRegistry.js";
// Types
export type {
  BM25SearchOptions,
  CreateTenantOptions,
  HybridSearchOptions,
  MultiTenancyConfig,
  Plugin,
  SchemaConfig,
  SearchableField,
  SearchMethod,
  SearchOptions,
  SearchRequest,
  SearchResult,
  Tenant,
  TenantActivityStatus,
  TenantContext,
  TenantManagementResult,
  TenantStats,
  UpdateTenantOptions,
  VectorIndexConfig,
  Vectorizer,
  VectorizerConfig,
  VectorSearchOptions,
} from "./types/index.js";
export type { WeaviateOptions } from "./Weaviate.js";
export { default as Weaviate } from "./Weaviate.js";
export { WeaviateConfigService } from "./WeaviateConfig.js";
