/**
 * Multi-tenancy configuration for Weaviate collections
 */
export interface MultiTenancyConfig {
  enabled: boolean;
  autoTenantCreation?: boolean;
  autoTenantActivation?: boolean;
}

/**
 * Weaviate v3 tenant activity status values
 */
export type TenantActivityStatus =
  | "HOT"
  | "COLD"
  | "FROZEN"
  | "INACTIVE"
  | "OFFLOADED"
  | "OFFLOADING"
  | "ONLOADING";

/**
 * Tenant information
 */
export interface Tenant {
  name: string;
  activityStatus: TenantActivityStatus;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Tenant creation options
 */
export interface CreateTenantOptions {
  name: string;
  activityStatus?: "HOT" | "COLD" | "FROZEN";
}

/**
 * Tenant update options
 */
export interface UpdateTenantOptions {
  activityStatus?: "HOT" | "COLD" | "FROZEN";
}

/**
 * Tenant context for operations
 */
export interface TenantContext {
  tenant: string;
  activityStatus?: "HOT" | "COLD" | "FROZEN";
}

/**
 * Multi-tenant search options
 */
export interface MultiTenantSearchOptions {
  tenant?: string;
  tenants?: string[];
  includeInactive?: boolean;
}

/**
 * Tenant statistics
 */
export interface TenantStats {
  totalTenants: number;
  activeTenants: number;
  inactiveTenants: number;
  coldTenants: number;
}

/**
 * Tenant management result
 */
export interface TenantManagementResult {
  success: boolean;
  tenant?: Tenant;
  error?: string;
}
