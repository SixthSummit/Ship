import { describe, expect, it } from "vitest";
import type {
  CreateTenantOptions,
  MultiTenancyConfig,
  Tenant,
  TenantActivityStatus,
  TenantContext,
  TenantManagementResult,
  TenantStats,
  UpdateTenantOptions,
} from "./MultiTenancy.js";

describe("MultiTenancy Types", () => {
  describe("MultiTenancyConfig", () => {
    it("should have correct structure", () => {
      const config: MultiTenancyConfig = {
        enabled: true,
        autoTenantCreation: true,
        autoTenantActivation: true,
      };

      expect(config.enabled).toBe(true);
      expect(config.autoTenantCreation).toBe(true);
      expect(config.autoTenantActivation).toBe(true);
    });

    it("should allow partial configuration", () => {
      const config: MultiTenancyConfig = {
        enabled: true,
      };

      expect(config.enabled).toBe(true);
      expect(config.autoTenantCreation).toBeUndefined();
      expect(config.autoTenantActivation).toBeUndefined();
    });
  });

  describe("Tenant", () => {
    it("should have correct structure", () => {
      const tenant: Tenant = {
        name: "acme-corp",
        activityStatus: "HOT",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      };

      expect(tenant.name).toBe("acme-corp");
      expect(tenant.activityStatus).toBe("HOT");
      expect(tenant.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(tenant.updatedAt).toBe("2024-01-01T00:00:00Z");
    });

    it("should allow minimal tenant structure", () => {
      const tenant: Tenant = {
        name: "beta-llc",
        activityStatus: "INACTIVE",
      };

      expect(tenant.name).toBe("beta-llc");
      expect(tenant.activityStatus).toBe("INACTIVE");
      expect(tenant.createdAt).toBeUndefined();
      expect(tenant.updatedAt).toBeUndefined();
    });

    it("should support all activity status values", () => {
      const statuses: TenantActivityStatus[] = [
        "HOT",
        "COLD",
        "FROZEN",
        "INACTIVE",
        "OFFLOADED",
        "OFFLOADING",
        "ONLOADING",
      ];

      statuses.forEach((status) => {
        const tenant: Tenant = { name: `tenant-${status.toLowerCase()}`, activityStatus: status };
        expect(tenant.activityStatus).toBe(status);
      });
    });
  });

  describe("CreateTenantOptions", () => {
    it("should have correct structure", () => {
      const options: CreateTenantOptions = {
        name: "acme-corp",
        activityStatus: "HOT",
      };

      expect(options.name).toBe("acme-corp");
      expect(options.activityStatus).toBe("HOT");
    });

    it("should allow minimal options", () => {
      const options: CreateTenantOptions = {
        name: "beta-llc",
      };

      expect(options.name).toBe("beta-llc");
      expect(options.activityStatus).toBeUndefined();
    });

    it("should support all activity status values", () => {
      const hotOptions: CreateTenantOptions = { name: "hot", activityStatus: "HOT" };
      const coldOptions: CreateTenantOptions = { name: "cold", activityStatus: "COLD" };
      const frozenOptions: CreateTenantOptions = { name: "frozen", activityStatus: "FROZEN" };

      expect(hotOptions.activityStatus).toBe("HOT");
      expect(coldOptions.activityStatus).toBe("COLD");
      expect(frozenOptions.activityStatus).toBe("FROZEN");
    });
  });

  describe("UpdateTenantOptions", () => {
    it("should have correct structure", () => {
      const options: UpdateTenantOptions = {
        activityStatus: "COLD",
      };

      expect(options.activityStatus).toBe("COLD");
    });

    it("should support all activity status values", () => {
      const hotOptions: UpdateTenantOptions = { activityStatus: "HOT" };
      const coldOptions: UpdateTenantOptions = { activityStatus: "COLD" };
      const frozenOptions: UpdateTenantOptions = { activityStatus: "FROZEN" };

      expect(hotOptions.activityStatus).toBe("HOT");
      expect(coldOptions.activityStatus).toBe("COLD");
      expect(frozenOptions.activityStatus).toBe("FROZEN");
    });
  });

  describe("TenantContext", () => {
    it("should have correct structure", () => {
      const context: TenantContext = {
        tenant: "acme-corp",
        activityStatus: "HOT",
      };

      expect(context.tenant).toBe("acme-corp");
      expect(context.activityStatus).toBe("HOT");
    });

    it("should allow minimal context", () => {
      const context: TenantContext = {
        tenant: "beta-llc",
      };

      expect(context.tenant).toBe("beta-llc");
      expect(context.activityStatus).toBeUndefined();
    });

    it("should support all activity status values", () => {
      const hotContext: TenantContext = { tenant: "hot", activityStatus: "HOT" };
      const coldContext: TenantContext = { tenant: "cold", activityStatus: "COLD" };
      const frozenContext: TenantContext = { tenant: "frozen", activityStatus: "FROZEN" };

      expect(hotContext.activityStatus).toBe("HOT");
      expect(coldContext.activityStatus).toBe("COLD");
      expect(frozenContext.activityStatus).toBe("FROZEN");
    });
  });

  describe("TenantStats", () => {
    it("should have correct structure", () => {
      const stats: TenantStats = {
        totalTenants: 10,
        activeTenants: 5,
        inactiveTenants: 3,
        coldTenants: 2,
      };

      expect(stats.totalTenants).toBe(10);
      expect(stats.activeTenants).toBe(5);
      expect(stats.inactiveTenants).toBe(3);
      expect(stats.coldTenants).toBe(2);
    });

    it("should allow zero values", () => {
      const stats: TenantStats = {
        totalTenants: 0,
        activeTenants: 0,
        inactiveTenants: 0,
        coldTenants: 0,
      };

      expect(stats.totalTenants).toBe(0);
      expect(stats.activeTenants).toBe(0);
      expect(stats.inactiveTenants).toBe(0);
      expect(stats.coldTenants).toBe(0);
    });
  });

  describe("TenantManagementResult", () => {
    it("should have correct structure for success", () => {
      const result: TenantManagementResult = {
        success: true,
        tenant: {
          name: "acme-corp",
          activityStatus: "HOT",
        },
      };

      expect(result.success).toBe(true);
      expect(result.tenant).toBeDefined();
      expect(result.tenant?.name).toBe("acme-corp");
      expect(result.error).toBeUndefined();
    });

    it("should have correct structure for failure", () => {
      const result: TenantManagementResult = {
        success: false,
        error: "Tenant already exists",
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tenant already exists");
      expect(result.tenant).toBeUndefined();
    });

    it("should allow minimal success result", () => {
      const result: TenantManagementResult = {
        success: true,
      };

      expect(result.success).toBe(true);
      expect(result.tenant).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe("Type Compatibility", () => {
    it("should be compatible with schema configuration", () => {
      const schemaConfig = {
        name: "UserDocuments",
        multiTenancy: {
          enabled: true,
          autoTenantCreation: true,
          autoTenantActivation: true,
        } as MultiTenancyConfig,
      };

      expect(schemaConfig.multiTenancy.enabled).toBe(true);
      expect(schemaConfig.multiTenancy.autoTenantCreation).toBe(true);
      expect(schemaConfig.multiTenancy.autoTenantActivation).toBe(true);
    });

    it("should be compatible with search options", () => {
      const searchOptions = {
        limit: 10,
        tenant: {
          tenant: "acme-corp",
          activityStatus: "HOT",
        } as TenantContext,
      };

      expect(searchOptions.tenant.tenant).toBe("acme-corp");
      expect(searchOptions.tenant.activityStatus).toBe("HOT");
    });

    it("should be compatible with tenant management operations", () => {
      const createOptions: CreateTenantOptions = { name: "acme-corp" };
      const updateOptions: UpdateTenantOptions = { activityStatus: "COLD" };
      const context: TenantContext = { tenant: "acme-corp" };
      const stats: TenantStats = {
        totalTenants: 1,
        activeTenants: 1,
        inactiveTenants: 0,
        coldTenants: 0,
      };
      const result: TenantManagementResult = {
        success: true,
        tenant: { name: "acme-corp", activityStatus: "HOT" },
      };

      expect(createOptions.name).toBe("acme-corp");
      expect(updateOptions.activityStatus).toBe("COLD");
      expect(context.tenant).toBe("acme-corp");
      expect(stats.totalTenants).toBe(1);
      expect(result.success).toBe(true);
    });
  });
});
