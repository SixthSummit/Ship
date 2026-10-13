import type { TenantContext } from "../types/MultiTenancy.js";

/**
 * Utility class for managing tenant context in multi-tenant operations
 */
export default class TenantContextManager {
  private static currentContext: TenantContext | null = null;

  /**
   * Set the current tenant context
   */
  static setContext(tenant: string, activityStatus?: "HOT" | "COLD" | "FROZEN"): void {
    TenantContextManager.currentContext = {
      tenant,
      activityStatus: activityStatus || "HOT",
    };
  }

  /**
   * Get the current tenant context
   */
  static getContext(): TenantContext | null {
    return TenantContextManager.currentContext;
  }

  /**
   * Clear the current tenant context
   */
  static clearContext(): void {
    TenantContextManager.currentContext = null;
  }

  /**
   * Check if a tenant context is set
   */
  static hasContext(): boolean {
    return TenantContextManager.currentContext !== null;
  }

  /**
   * Get the current tenant name
   */
  static getCurrentTenant(): string | null {
    return TenantContextManager.currentContext?.tenant || null;
  }

  /**
   * Execute a function with a specific tenant context
   */
  static async withContext<T>(
    tenant: string,
    activityStatus: "HOT" | "COLD" | "FROZEN" | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previousContext = TenantContextManager.currentContext;

    try {
      TenantContextManager.setContext(tenant, activityStatus);
      return await fn();
    } finally {
      TenantContextManager.currentContext = previousContext;
    }
  }

  /**
   * Create a tenant context object
   */
  static createContext(tenant: string, activityStatus?: "HOT" | "COLD" | "FROZEN"): TenantContext {
    return {
      tenant,
      activityStatus: activityStatus || "HOT",
    };
  }

  /**
   * Validate tenant name format
   */
  static validateTenantName(tenant: string): boolean {
    // Weaviate tenant names must be lowercase and contain only alphanumeric characters and hyphens
    return /^[a-z0-9-]+$/.test(tenant) && tenant.length > 0 && tenant.length <= 63;
  }

  /**
   * Sanitize tenant name to meet Weaviate requirements
   */
  static sanitizeTenantName(tenant: string): string {
    return tenant
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 63);
  }
}
