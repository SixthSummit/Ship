import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WeaviateClient } from "weaviate-client";
import Weaviate from "./Weaviate.js";
import { WeaviateConfigService } from "./WeaviateConfig.js";

// Mock the Logger
vi.mock("@sixthsummit/ship-api/app/utils/Logger", () => ({
  default: {
    log: vi.fn(),
  },
}));

// Mock the WeaviateConfigService
vi.mock("./WeaviateConfig.js", () => ({
  WeaviateConfigService: {
    getClient: vi.fn(),
    initializeClient: vi.fn(),
  },
}));

// No default plugins to mock anymore
vi.mock("./plugins/index.js", () => ({}));

describe("Weaviate", () => {
  let weaviate: Weaviate;
  let mockWeaviateClient: vi.Mocked<WeaviateClient>;

  beforeEach(() => {
    mockWeaviateClient = {
      getMeta: vi.fn().mockResolvedValue({ version: "1.0.0" }),
      collections: {
        createFromSchema: vi.fn().mockResolvedValue({}),
        exists: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue({}),
        export: vi.fn().mockResolvedValue({ multiTenancy: { enabled: true } }),
        get: vi.fn().mockImplementation((className: string) => {
          const collection = {
            data: {
              insert: vi.fn().mockResolvedValue("test-id"),
              insertMany: vi
                .fn()
                .mockResolvedValue({ uuids: { "0": "test-id-1", "1": "test-id-2" } }),
              deleteById: vi.fn().mockResolvedValue({}),
              update: vi.fn().mockResolvedValue({}),
            },
            query: {
              hybrid: vi.fn().mockResolvedValue({
                objects: [
                  {
                    uuid: "doc-1",
                    properties: { content: "test content" },
                    vectors: { default: [0.1, 0.2, 0.3] },
                    metadata: { score: 0.9, explainScore: "bm25: 0.5, vector: 0.4" },
                  },
                ],
              }),
              nearText: vi.fn().mockResolvedValue({
                objects: [
                  {
                    uuid: "test-person-id",
                    properties: { fullName: "Test Person" },
                    vectors: { default: [0.4, 0.5, 0.6] },
                    metadata: { certainty: 0.8, distance: 0.2 },
                  },
                ],
              }),
              bm25: vi.fn().mockResolvedValue({
                objects: [
                  {
                    uuid: "doc-1",
                    properties: { content: "test content" },
                    vectors: { default: [0.1, 0.2, 0.3] },
                    metadata: { score: 0.9, explainScore: "bm25 match" },
                  },
                ],
              }),
              nearVector: vi.fn().mockResolvedValue({
                objects: [
                  {
                    uuid: "test-person-id",
                    properties: { fullName: "Test Person" },
                    vectors: { default: [0.4, 0.5, 0.6] },
                    metadata: { certainty: 0.8, distance: 0.2 },
                  },
                ],
              }),
              fetchObjectById: vi.fn().mockResolvedValue({ properties: {} }),
              fetchObjects: vi.fn().mockResolvedValue({ objects: [] }),
            },
            aggregate: {
              overAll: vi.fn().mockResolvedValue({ totalCount: 10 }),
            },
            tenants: {
              create: vi.fn().mockResolvedValue([{ name: "test-tenant" }]),
              get: vi.fn().mockResolvedValue({
                "acme-corp": { name: "acme-corp", activityStatus: "HOT" },
                "beta-llc": { name: "beta-llc", activityStatus: "INACTIVE" },
                "charlie-inc": { name: "charlie-inc", activityStatus: "COLD" },
              }),
              update: vi.fn().mockResolvedValue([]),
              remove: vi.fn().mockResolvedValue([]),
            },
            config: {
              get: vi.fn().mockResolvedValue({ multiTenancyConfig: { enabled: true } }),
            },
            withTenant: vi.fn().mockImplementation((tenant: string) => collection),
          };
          return collection;
        }),
      },
    } as any;

    // Mock WeaviateConfigService to return our mock client
    (WeaviateConfigService.getClient as any).mockResolvedValue(mockWeaviateClient); // Async

    weaviate = new Weaviate();

    // Register required schemas for tests
    weaviate.registerSchema({
      name: "Person",
      description: "Person entity",
      properties: [
        { name: "fullName", dataType: ["string"], indexInverted: true },
        { name: "headline", dataType: ["string"], indexInverted: true },
      ],
    });

    weaviate.registerSchema({
      name: "Organization",
      description: "Organization entity",
      properties: [
        { name: "name", dataType: ["string"], indexInverted: true },
        { name: "description", dataType: ["string"], indexInverted: true },
      ],
    });

    weaviate.registerSchema({
      name: "UserDocuments",
      description: "User documents with multi-tenancy",
      multiTenancy: {
        enabled: true,
        autoTenantCreation: true,
        autoTenantActivation: true,
      },
      properties: [
        { name: "title", dataType: ["string"], indexInverted: true },
        { name: "content", dataType: ["text"], indexInverted: true },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create instance without initializing client", () => {
      expect(weaviate).toBeDefined();
      // Client should NOT be initialized yet - lazy initialization
      expect(WeaviateConfigService.getClient).not.toHaveBeenCalled();
    });
  });

  describe("createSchema", () => {
    it("should create a schema successfully", async () => {
      const schema = {
        name: "TestClass",
        description: "Test schema",
        properties: [{ name: "name", dataType: ["string"], indexInverted: true }],
      };

      await weaviate.createSchema(schema);

      expect(mockWeaviateClient.collections.createFromSchema).toHaveBeenCalled();
    });

    it("should handle schema already exists error", async () => {
      const schema = {
        name: "TestClass",
        description: "Test schema",
        properties: [{ name: "name", dataType: ["string"], indexInverted: true }],
      };

      // Mock error for already exists
      (mockWeaviateClient.collections.createFromSchema as any).mockRejectedValueOnce(
        new Error("class already exists"),
      );

      await weaviate.createSchema(schema);

      expect(mockWeaviateClient.collections.createFromSchema).toHaveBeenCalled();
    });
  });

  describe("createObject", () => {
    it("should create an object successfully", async () => {
      const obj = {
        class: "Person",
        properties: { fullName: "Test Person" },
      };

      const result = await weaviate.createObject(obj);

      expect(result).toBe("test-id");
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });
  });

  describe("createObjectsBatch", () => {
    it("should create multiple objects in batch", async () => {
      const objects = [
        { class: "Person", properties: { fullName: "Person 1" } },
        { class: "Person", properties: { fullName: "Person 2" } },
      ];

      const result = await weaviate.createObjectsBatch(objects);

      expect(result).toEqual(["test-id-1", "test-id-2"]);
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });
  });

  describe("searchObjects", () => {
    it("should search objects with hybrid and return correct structure", async () => {
      const result = await weaviate.searchObjects("Person", {
        method: "hybrid",
        options: {
          limit: 10,
          offset: 0,
          hybrid: { query: "test" },
        },
      });

      expect(result.objects).toHaveLength(1);
      expect(result.total).toBe(1);

      const obj = result.objects[0];
      expect(obj.id).toBe("doc-1");
      expect(obj.properties).toEqual({ content: "test content" });
      expect(obj.vector).toEqual([0.1, 0.2, 0.3]);
      expect(obj.score).toBe(0.9);
      expect(obj.metadata).toEqual({ score: 0.9, explainScore: "bm25: 0.5, vector: 0.4" });
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });

    it("should search objects with nearText and return correct structure", async () => {
      const result = await weaviate.searchObjects("Person", {
        method: "vector",
        options: {
          nearText: {
            concepts: ["test query"],
            certainty: 0.7,
          },
        },
      });

      expect(result.objects).toHaveLength(1);
      expect(result.total).toBe(1);

      const obj = result.objects[0];
      expect(obj.id).toBe("test-person-id");
      expect(obj.properties).toEqual({ fullName: "Test Person" });
      expect(obj.vector).toEqual([0.4, 0.5, 0.6]);
      expect(obj.certainty).toBe(0.8);
      expect(obj.distance).toBe(0.2);
      expect(obj.metadata).toEqual({ certainty: 0.8, distance: 0.2 });
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });

    it("should search objects with bm25 and return correct structure", async () => {
      const result = await weaviate.searchObjects("Person", {
        method: "bm25",
        options: {
          bm25: { query: "test query" },
        },
      });

      expect(result.objects).toHaveLength(1);
      expect(result.total).toBe(1);

      const obj = result.objects[0];
      expect(obj.id).toBe("doc-1");
      expect(obj.properties).toEqual({ content: "test content" });
      expect(obj.vector).toEqual([0.1, 0.2, 0.3]);
      expect(obj.score).toBe(0.9);
      expect(obj.metadata).toEqual({ score: 0.9, explainScore: "bm25 match" });
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });

    it("should handle objects without vectors", async () => {
      // Override mock to return objects without vectors
      const originalGet = mockWeaviateClient.collections.get;
      (mockWeaviateClient.collections.get as any).mockImplementationOnce((className: string) => {
        const coll = originalGet(className);
        coll.query.hybrid = vi.fn().mockResolvedValue({
          objects: [
            {
              uuid: "no-vector-doc",
              properties: { content: "no vector" },
              metadata: { score: 0.5 },
            },
          ],
        });
        return coll;
      });

      const result = await weaviate.searchObjects("Person", {
        method: "hybrid",
        options: { hybrid: { query: "test" } },
      });

      expect(result.objects[0].id).toBe("no-vector-doc");
      expect(result.objects[0].vector).toBeUndefined();
    });
  });

  describe("healthCheck", () => {
    it("should return true when Weaviate is healthy", async () => {
      const result = await weaviate.healthCheck();

      expect(result).toBe(true);
      expect(mockWeaviateClient.getMeta).toHaveBeenCalled();
    });

    it("should return false when Weaviate is unhealthy", async () => {
      (mockWeaviateClient.getMeta as any).mockRejectedValueOnce(new Error("Connection failed"));

      const result = await weaviate.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe("getObjectCount", () => {
    it("should get object count for a class", async () => {
      const result = await weaviate.getObjectCount("Person");

      expect(result).toBe(10);
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });
  });

  describe("deleteObject", () => {
    it("should delete an object", async () => {
      await weaviate.deleteObject("Person", "person-123");

      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });
  });

  describe("updateObject", () => {
    it("should update an object", async () => {
      const properties = { fullName: "Updated Name" };
      await weaviate.updateObject("Person", "person-123", properties);

      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });
  });

  describe("getObject", () => {
    it("should get an object by ID", async () => {
      const result = await weaviate.getObject("Person", "person-123");

      expect(result).toEqual({});
      expect(mockWeaviateClient.collections.get).toHaveBeenCalledWith("Person");
    });
  });

  describe("Multi-Tenancy", () => {
    describe("createTenant", () => {
      it("should create a tenant successfully", async () => {
        const tenantOptions = { name: "acme-corp", activityStatus: "HOT" as const };

        const result = await weaviate.createTenant("UserDocuments", tenantOptions);

        expect(result.success).toBe(true);
        expect(result.tenant).toBeDefined();
      });

      it("should handle tenant creation errors", async () => {
        const tenantOptions = { name: "acme-corp", activityStatus: "HOT" as const };

        // Mock error for tenant creation by overriding the get implementation temporarily
        const mockCollection = {
          ...mockWeaviateClient.collections.get("UserDocuments"),
          tenants: {
            create: vi.fn().mockRejectedValue(new Error("Tenant already exists")),
            get: vi.fn(),
            update: vi.fn(),
            remove: vi.fn(),
          },
        };
        (mockWeaviateClient.collections.get as any).mockReturnValueOnce(mockCollection);

        const result = await weaviate.createTenant("UserDocuments", tenantOptions);

        expect(result.success).toBe(false);
        expect(result.error).toContain("Tenant already exists");
      });
    });

    describe("listTenants", () => {
      it("should list all tenants for a schema", async () => {
        const result = await weaviate.listTenants("UserDocuments");

        // Should transform from the mocked object format to array format
        expect(result.length).toBe(3);
        expect(result).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "acme-corp", activityStatus: "HOT" }),
            expect.objectContaining({ name: "beta-llc", activityStatus: "INACTIVE" }),
            expect.objectContaining({ name: "charlie-inc", activityStatus: "COLD" }),
          ]),
        );
      });
    });

    describe("getTenant", () => {
      it("should get a specific tenant", async () => {
        const result = await weaviate.getTenant("UserDocuments", "acme-corp");

        expect(result).toEqual(
          expect.objectContaining({ name: "acme-corp", activityStatus: "HOT" }),
        );
      });

      it("should return null for non-existent tenant", async () => {
        const result = await weaviate.getTenant("UserDocuments", "non-existent");

        expect(result).toBeNull();
      });
    });

    describe("updateTenant", () => {
      it("should update a tenant", async () => {
        const updateOptions = { activityStatus: "COLD" as const };

        const result = await weaviate.updateTenant("UserDocuments", "acme-corp", updateOptions);

        expect(result.success).toBe(true);
      });
    });

    describe("deleteTenant", () => {
      it("should delete a tenant", async () => {
        const result = await weaviate.deleteTenant("UserDocuments", "acme-corp");

        expect(result.success).toBe(true);
      });
    });

    describe("getTenantStats", () => {
      it("should get tenant statistics", async () => {
        const result = await weaviate.getTenantStats("UserDocuments");

        // Mock tenants: acme-corp=HOT, beta-llc=INACTIVE, charlie-inc=COLD
        expect(result.totalTenants).toBe(3);
        expect(result.activeTenants).toBe(1);
        expect(result.inactiveTenants).toBe(1);
        expect(result.coldTenants).toBe(1);
      });
    });

    describe("isMultiTenant", () => {
      it("should check if schema is multi-tenant", async () => {
        const result = await weaviate.isMultiTenant("UserDocuments");

        expect(result).toBe(true);
      });

      it("should return false for non-multi-tenant schema", async () => {
        // Mock non-multi-tenant schema
        (mockWeaviateClient.collections.export as any).mockResolvedValueOnce({
          multiTenancy: { enabled: false },
        });

        const result = await weaviate.isMultiTenant("Person");

        expect(result).toBe(false);
      });
    });

    describe("searchWithTenant", () => {
      it("should execute vector search with tenant context", async () => {
        // Track withTenant calls
        const mockWithTenant = vi.fn().mockImplementation((tenant: string) => {
          const collection = mockWeaviateClient.collections.get("UserDocuments");
          return collection;
        });

        // Override the collection mock to track withTenant
        const originalGet = mockWeaviateClient.collections.get;
        (mockWeaviateClient.collections.get as any) = vi
          .fn()
          .mockImplementation((className: string) => {
            const coll = originalGet(className);
            coll.withTenant = mockWithTenant;
            return coll;
          });

        const result = await weaviate.searchWithTenant(
          "UserDocuments",
          {
            method: "vector",
            options: { nearText: { concepts: ["test query"] } },
          },
          "acme-corp",
        );

        expect(mockWithTenant).toHaveBeenCalledWith("acme-corp");
        expect(result.objects).toHaveLength(1);

        const obj = result.objects[0];
        expect(obj.id).toBe("test-person-id");
        expect(obj.properties).toEqual({ fullName: "Test Person" });
        expect(obj.vector).toEqual([0.4, 0.5, 0.6]);
        expect(obj.certainty).toBe(0.8);
        expect(obj.distance).toBe(0.2);
        expect(obj.metadata).toEqual({ certainty: 0.8, distance: 0.2 });
      });

      it("should execute BM25 search with tenant context", async () => {
        // Track withTenant calls
        const mockWithTenant = vi.fn().mockImplementation((tenant: string) => {
          const collection = mockWeaviateClient.collections.get("UserDocuments");
          return collection;
        });

        // Override the collection mock to track withTenant
        const originalGet = mockWeaviateClient.collections.get;
        (mockWeaviateClient.collections.get as any) = vi
          .fn()
          .mockImplementation((className: string) => {
            const coll = originalGet(className);
            coll.withTenant = mockWithTenant;
            return coll;
          });

        const result = await weaviate.searchWithTenant(
          "UserDocuments",
          {
            method: "bm25",
            options: { bm25: { query: "test query" } },
          },
          "acme-corp",
        );

        expect(mockWithTenant).toHaveBeenCalledWith("acme-corp");
        expect(result.objects).toHaveLength(1);

        const obj = result.objects[0];
        expect(obj.id).toBe("doc-1");
        expect(obj.properties).toEqual({ content: "test content" });
        expect(obj.vector).toEqual([0.1, 0.2, 0.3]);
        expect(obj.score).toBe(0.9);
        expect(obj.metadata).toEqual({ score: 0.9, explainScore: "bm25 match" });
      });

      it("should execute hybrid search with tenant context", async () => {
        // Track withTenant calls
        const mockWithTenant = vi.fn().mockImplementation((tenant: string) => {
          const collection = mockWeaviateClient.collections.get("UserDocuments");
          return collection;
        });

        // Override the collection mock to track withTenant
        const originalGet = mockWeaviateClient.collections.get;
        (mockWeaviateClient.collections.get as any) = vi
          .fn()
          .mockImplementation((className: string) => {
            const coll = originalGet(className);
            coll.withTenant = mockWithTenant;
            return coll;
          });

        const result = await weaviate.searchWithTenant(
          "UserDocuments",
          {
            method: "hybrid",
            options: { hybrid: { query: "test query", alpha: 0.5 } },
          },
          "acme-corp",
        );

        expect(mockWithTenant).toHaveBeenCalledWith("acme-corp");
        expect(result.objects).toHaveLength(1);

        const obj = result.objects[0];
        expect(obj.id).toBe("doc-1");
        expect(obj.properties).toEqual({ content: "test content" });
        expect(obj.vector).toEqual([0.1, 0.2, 0.3]);
        expect(obj.score).toBe(0.9);
        expect(obj.metadata).toEqual({ score: 0.9, explainScore: "bm25: 0.5, vector: 0.4" });
      });
    });
  });

  describe("Filter Builder (Phase 1: Weaviate Scoping)", () => {
    describe("isPlainFilterObject", () => {
      it("should detect plain filter objects", () => {
        const plainFilter = {
          path: ["publicId"],
          operator: "ContainsAny",
          valueString: ["id1", "id2"],
        };

        const result = (weaviate as any).isPlainFilterObject(plainFilter);
        expect(result).toBe(true);
      });

      it("should return false for non-plain objects", () => {
        const notPlain1 = { someOther: "property" };
        const notPlain2 = { path: ["id"], operator: "Equal" }; // Missing valueString

        expect((weaviate as any).isPlainFilterObject(notPlain1)).toBe(false);
        expect((weaviate as any).isPlainFilterObject(notPlain2)).toBe(false);
      });

      it("should return false for null and undefined", () => {
        // null and undefined should be falsy, returning false
        expect((weaviate as any).isPlainFilterObject(null)).toBeFalsy();
        expect((weaviate as any).isPlainFilterObject(undefined)).toBeFalsy();
      });

      it("should return false for FilterValue objects", () => {
        const filterValue = {
          _operator: "ContainsAny",
          _property: "publicId",
          _values: ["id1"],
        };

        const result = (weaviate as any).isPlainFilterObject(filterValue);
        expect(result).toBe(false);
      });
    });

    describe("buildFilter", () => {
      let mockCollection: any;

      beforeEach(() => {
        // Create mock collection with filter builder API
        mockCollection = {
          filter: {
            byProperty: vi.fn((prop: string) => ({
              containsAny: vi.fn((vals: any[]) => ({
                _operator: "ContainsAny",
                _property: prop,
                _values: vals,
              })),
              containsAll: vi.fn((vals: any[]) => ({
                _operator: "ContainsAll",
                _property: prop,
                _values: vals,
              })),
              equal: vi.fn((val: any) => ({
                _operator: "Equal",
                _property: prop,
                _value: val,
              })),
              notEqual: vi.fn((val: any) => ({
                _operator: "NotEqual",
                _property: prop,
                _value: val,
              })),
              greaterThan: vi.fn((val: any) => ({
                _operator: "GreaterThan",
                _property: prop,
                _value: val,
              })),
              greaterOrEqual: vi.fn((val: any) => ({
                _operator: "GreaterThanEqual",
                _property: prop,
                _value: val,
              })),
              lessThan: vi.fn((val: any) => ({
                _operator: "LessThan",
                _property: prop,
                _value: val,
              })),
              lessOrEqual: vi.fn((val: any) => ({
                _operator: "LessThanEqual",
                _property: prop,
                _value: val,
              })),
              like: vi.fn((val: string) => ({
                _operator: "Like",
                _property: prop,
                _value: val,
              })),
              isNull: vi.fn((val: boolean) => ({
                _operator: "IsNull",
                _property: prop,
                _value: val,
              })),
            })),
          },
        };
      });

      it("should build ContainsAny filter", () => {
        const filterObj = {
          path: ["publicId"],
          operator: "ContainsAny",
          valueString: ["id1", "id2", "id3"],
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        expect(result._operator).toBe("ContainsAny");
        expect(result._property).toBe("publicId");
        expect(result._values).toEqual(["id1", "id2", "id3"]);
        expect(mockCollection.filter.byProperty).toHaveBeenCalledWith("publicId");
      });

      it("should build Equal filter", () => {
        const filterObj = {
          path: ["name"],
          operator: "Equal",
          valueString: "John Doe",
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        expect(result._operator).toBe("Equal");
        expect(result._property).toBe("name");
        expect(result._value).toBe("John Doe");
      });

      it("should build GreaterThan filter", () => {
        const filterObj = {
          path: ["age"],
          operator: "GreaterThan",
          valueString: 18,
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        expect(result._operator).toBe("GreaterThan");
        expect(result._property).toBe("age");
      });

      it("should handle large arrays (10k items)", () => {
        const largeArray = Array.from({ length: 10000 }, (_, i) => `id-${i}`);
        const filterObj = {
          path: ["publicId"],
          operator: "ContainsAny",
          valueString: largeArray,
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        expect(result._operator).toBe("ContainsAny");
        expect(result._values).toHaveLength(10000);
      });

      it("should return as-is if not a plain object", () => {
        const alreadyBuilt = {
          _operator: "ContainsAny",
          _property: "publicId",
          _values: ["id1"],
        };

        const result = (weaviate as any).buildFilter(mockCollection, alreadyBuilt);

        // Should return same object, not rebuild
        expect(result).toBe(alreadyBuilt);
      });

      it("should return undefined if collection.filter is missing", () => {
        const noFilterCollection = {}; // No filter property

        const filterObj = {
          path: ["publicId"],
          operator: "ContainsAny",
          valueString: ["id1"],
        };

        const result = (weaviate as any).buildFilter(noFilterCollection, filterObj);

        expect(result).toBeUndefined();
      });

      it("should return undefined if path is empty array (plain object with empty path)", () => {
        const filterObj = {
          path: [], // Empty array
          operator: "ContainsAny",
          valueString: ["id1"],
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        // This IS a plain object (has all properties), so buildFilter processes it
        // and returns undefined due to empty path validation
        expect(result).toBeUndefined();
      });

      it("should return as-is if path is missing (not a plain object)", () => {
        const filterObj = {
          // path missing
          operator: "ContainsAny",
          valueString: ["id1"],
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        // Returns as-is because isPlainFilterObject returns false (missing path)
        expect(result).toBe(filterObj);
      });

      it("should return as-is if valueString is missing (not a plain object)", () => {
        const filterObj = {
          path: ["publicId"],
          operator: "ContainsAny",
          // valueString missing - not a plain object
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        // Returns as-is because isPlainFilterObject returns false
        expect(result).toBe(filterObj);
      });

      it("should return undefined for unsupported operators", () => {
        const filterObj = {
          path: ["publicId"],
          operator: "UnsupportedOperator",
          valueString: "value",
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        expect(result).toBeUndefined();
      });

      it("should return undefined for compound filters (And/Or not yet supported)", () => {
        const filterObj = {
          path: ["publicId"],
          operator: "And",
          valueString: "value",
        };

        const result = (weaviate as any).buildFilter(mockCollection, filterObj);

        expect(result).toBeUndefined();
      });

      it("should handle errors gracefully", () => {
        const brokenCollection = {
          filter: {
            byProperty: vi.fn(() => {
              throw new Error("Something broke");
            }),
          },
        };

        const filterObj = {
          path: ["publicId"],
          operator: "ContainsAny",
          valueString: ["id1"],
        };

        const result = (weaviate as any).buildFilter(brokenCollection, filterObj);

        expect(result).toBeUndefined();
      });

      it("should support all implemented operators", () => {
        const operators = [
          { operator: "ContainsAny", method: "containsAny" },
          { operator: "ContainsAll", method: "containsAll" },
          { operator: "Equal", method: "equal" },
          { operator: "NotEqual", method: "notEqual" },
          { operator: "GreaterThan", method: "greaterThan" },
          { operator: "GreaterThanEqual", method: "greaterOrEqual" },
          { operator: "LessThan", method: "lessThan" },
          { operator: "LessThanEqual", method: "lessOrEqual" },
          { operator: "Like", method: "like" },
          { operator: "IsNull", method: "isNull" },
        ];

        operators.forEach(({ operator }) => {
          const filterObj = {
            path: ["testProp"],
            operator,
            valueString: operator === "IsNull" ? true : "testValue",
          };

          const result = (weaviate as any).buildFilter(mockCollection, filterObj);

          expect(result).toBeDefined();
          expect(result._operator).toBeTruthy();
          expect(mockCollection.filter.byProperty).toHaveBeenCalledWith("testProp");
        });
      });
    });
  });
});
