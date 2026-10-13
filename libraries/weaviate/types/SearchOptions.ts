import type { TenantContext } from "./MultiTenancy.js";

export interface SearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  where?: Record<string, any>;
  sort?: Array<{
    field: string;
    order: "asc" | "desc";
  }>;
  fields?: string[]; // Specific fields to return
  includeVector?: boolean;
  includeMetadata?: boolean;
  tenant?: TenantContext; // Tenant context for multi-tenant operations
}
