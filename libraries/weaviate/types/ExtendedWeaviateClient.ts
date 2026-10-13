import type { WeaviateClient } from "weaviate-client";

/**
 * Extended WeaviateClient type
 * Note: v3 client has proper typing, so this just re-exports WeaviateClient for compatibility
 */
export type ExtendedWeaviateClient = WeaviateClient;
