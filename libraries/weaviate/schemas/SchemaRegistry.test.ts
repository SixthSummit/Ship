import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin, SchemaConfig, SearchMethod } from "../types/index.js";
import SchemaRegistry from "./SchemaRegistry.js";

// Mock the Logger
vi.mock("@sixthsummit/ship-api/app/utils/Logger", () => ({
  default: {
    log: vi.fn(),
  },
}));

describe("SchemaRegistry", () => {
  let registry: SchemaRegistry;

  beforeEach(() => {
    // Clear static instance before each test
    (SchemaRegistry as any).instance = undefined;
    registry = new SchemaRegistry();
  });

  describe("static singleton pattern", () => {
    it("should initialize static instance", () => {
      const schemas = [
        {
          name: "Person",
          description: "Person entity",
          properties: [{ name: "name", dataType: ["string"] }],
        },
        {
          name: "Organization",
          description: "Organization entity",
          properties: [{ name: "name", dataType: ["string"] }],
        },
      ];

      SchemaRegistry.initialize(schemas);
      const instance = SchemaRegistry.getInstance();

      expect(instance).toBeDefined();
      expect(SchemaRegistry.isInitialized()).toBe(true);
    });

    it("should throw error when getting instance before initialization", () => {
      // Clear static instance first
      (SchemaRegistry as any).instance = undefined;
      expect(() => SchemaRegistry.getInstance()).toThrow("SchemaRegistry not initialized");
    });

    it("should return same instance on multiple calls", () => {
      const schemas = [
        { name: "Test", description: "Test", properties: [{ name: "id", dataType: ["string"] }] },
      ];
      SchemaRegistry.initialize(schemas);

      const instance1 = SchemaRegistry.getInstance();
      const instance2 = SchemaRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("constructor", () => {
    it("should initialize with empty collections", () => {
      expect(registry).toBeDefined();
    });

    it("should register default search methods", () => {
      const methods = registry.getAllSearchMethods();
      expect(methods).toHaveLength(3);
      expect(methods.map((m) => m.name)).toEqual(["vector", "bm25", "hybrid"]);
    });

    it("should register provided schemas", () => {
      const schemas = [
        {
          name: "Person",
          description: "Person entity",
          properties: [{ name: "name", dataType: ["string"] }],
        },
        {
          name: "Organization",
          description: "Organization entity",
          properties: [{ name: "name", dataType: ["string"] }],
        },
      ];

      const registryWithSchemas = new SchemaRegistry(schemas);
      expect(registryWithSchemas.hasSchema("Person")).toBe(true);
      expect(registryWithSchemas.hasSchema("Organization")).toBe(true);
    });
  });

  describe("registerSchema", () => {
    it("should register a schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "name", dataType: ["string"], indexInverted: true }],
      };

      registry.registerSchema(schema);
      expect(registry.hasSchema("TestSchema")).toBe(true);
      expect(registry.getSchema("TestSchema")).toEqual(schema);
    });

    it("should overwrite existing schema with same name", () => {
      const schema1: SchemaConfig = {
        name: "TestSchema",
        description: "First schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      const schema2: SchemaConfig = {
        name: "TestSchema",
        description: "Second schema",
        properties: [{ name: "name", dataType: ["string"] }],
      };

      registry.registerSchema(schema1);
      registry.registerSchema(schema2);

      expect(registry.getSchema("TestSchema")).toEqual(schema2);
    });
  });

  describe("registerSchemas", () => {
    it("should register multiple schemas", () => {
      const schemas = {
        Schema1: {
          name: "Schema1",
          description: "First schema",
          properties: [{ name: "id", dataType: ["string"] }],
        },
        Schema2: {
          name: "Schema2",
          description: "Second schema",
          properties: [{ name: "id", dataType: ["string"] }],
        },
      };

      registry.registerSchemas(schemas);
      expect(registry.hasSchema("Schema1")).toBe(true);
      expect(registry.hasSchema("Schema2")).toBe(true);
    });
  });

  describe("getSchema", () => {
    it("should return undefined for non-existent schema", () => {
      expect(registry.getSchema("NonExistent")).toBeUndefined();
    });

    it("should return registered schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema);
      expect(registry.getSchema("TestSchema")).toEqual(schema);
    });
  });

  describe("getAllSchemas", () => {
    it("should return all registered schemas", () => {
      const schema1: SchemaConfig = {
        name: "Schema1",
        description: "First schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };
      const schema2: SchemaConfig = {
        name: "Schema2",
        description: "Second schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema1);
      registry.registerSchema(schema2);

      const allSchemas = registry.getAllSchemas();
      expect(allSchemas).toHaveLength(2);
      expect(allSchemas).toContain(schema1);
      expect(allSchemas).toContain(schema2);
    });
  });

  describe("hasSchema", () => {
    it("should return false for non-existent schema", () => {
      expect(registry.hasSchema("NonExistent")).toBe(false);
    });

    it("should return true for existing schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema);
      expect(registry.hasSchema("TestSchema")).toBe(true);
    });
  });

  describe("getSchemaNames", () => {
    it("should return array of schema names", () => {
      registry.registerSchema({
        name: "Schema1",
        description: "Test",
        properties: [{ name: "id", dataType: ["string"] }],
      });
      registry.registerSchema({
        name: "Schema2",
        description: "Test",
        properties: [{ name: "id", dataType: ["string"] }],
      });

      const names = registry.getSchemaNames();
      expect(names).toHaveLength(2);
      expect(names).toContain("Schema1");
      expect(names).toContain("Schema2");
    });
  });

  describe("registerPlugin", () => {
    it("should register a plugin", () => {
      const plugin: Plugin = {
        name: "testPlugin",
        version: "1.0.0",
        description: "Test plugin",
        hooks: {
          beforeSearch: vi.fn(),
          afterSearch: vi.fn(),
          beforeCreate: vi.fn(),
        },
      };

      registry.registerPlugin(plugin);
      expect(registry.getPlugin("testPlugin")).toEqual(plugin);
    });
  });

  describe("getPlugin", () => {
    it("should return undefined for non-existent plugin", () => {
      expect(registry.getPlugin("NonExistent")).toBeUndefined();
    });

    it("should return registered plugin", () => {
      const plugin: Plugin = {
        name: "testPlugin",
        version: "1.0.0",
        description: "Test plugin",
        hooks: {
          beforeSearch: vi.fn(),
          afterSearch: vi.fn(),
          beforeCreate: vi.fn(),
        },
      };

      registry.registerPlugin(plugin);
      expect(registry.getPlugin("testPlugin")).toEqual(plugin);
    });
  });

  describe("getSchemaPlugins", () => {
    it("should return empty array for schema without plugins", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema);
      expect(registry.getSchemaPlugins("TestSchema")).toEqual([]);
    });

    it("should return plugins for schema with plugins", () => {
      const plugin1: Plugin = {
        name: "plugin1",
        version: "1.0.0",
        description: "Plugin 1",
        hooks: { beforeSearch: vi.fn(), afterSearch: vi.fn(), beforeCreate: vi.fn() },
      };
      const plugin2: Plugin = {
        name: "plugin2",
        version: "1.0.0",
        description: "Plugin 2",
        hooks: { beforeSearch: vi.fn(), afterSearch: vi.fn(), beforeCreate: vi.fn() },
      };

      registry.registerPlugin(plugin1);
      registry.registerPlugin(plugin2);

      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        plugins: ["plugin1", "plugin2"],
      };

      registry.registerSchema(schema);
      const plugins = registry.getSchemaPlugins("TestSchema");
      expect(plugins).toHaveLength(2);
      expect(plugins).toContain(plugin1);
      expect(plugins).toContain(plugin2);
    });

    it("should filter out non-existent plugins", () => {
      const plugin: Plugin = {
        name: "plugin1",
        version: "1.0.0",
        description: "Plugin 1",
        hooks: { beforeSearch: vi.fn(), afterSearch: vi.fn(), beforeCreate: vi.fn() },
      };

      registry.registerPlugin(plugin);

      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        plugins: ["plugin1", "nonExistent"],
      };

      registry.registerSchema(schema);
      const plugins = registry.getSchemaPlugins("TestSchema");
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toEqual(plugin);
    });
  });

  describe("registerSearchMethod", () => {
    it("should register a search method", () => {
      const method: SearchMethod = {
        name: "custom",
        description: "Custom search method",
        supportedOptions: ["query"],
        execute: vi.fn(),
      };

      registry.registerSearchMethod(method);
      expect(registry.getSearchMethod("custom")).toEqual(method);
    });
  });

  describe("getSearchMethod", () => {
    it("should return undefined for non-existent method", () => {
      expect(registry.getSearchMethod("NonExistent")).toBeUndefined();
    });

    it("should return registered method", () => {
      const method: SearchMethod = {
        name: "custom",
        description: "Custom search method",
        supportedOptions: ["query"],
        execute: vi.fn(),
      };

      registry.registerSearchMethod(method);
      expect(registry.getSearchMethod("custom")).toEqual(method);
    });
  });

  describe("getAllSearchMethods", () => {
    it("should return all search methods including defaults", () => {
      const customMethod: SearchMethod = {
        name: "custom",
        description: "Custom search method",
        supportedOptions: ["query"],
        execute: vi.fn(),
      };

      registry.registerSearchMethod(customMethod);
      const methods = registry.getAllSearchMethods();

      expect(methods).toHaveLength(4); // 3 defaults + 1 custom
      expect(methods.map((m) => m.name)).toContain("vector", "bm25", "hybrid", "custom");
    });
  });

  describe("getSearchableFields", () => {
    it("should return empty array for schema without searchable fields", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema);
      expect(registry.getSearchableFields("TestSchema")).toEqual([]);
    });

    it("should return searchable fields for schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        searchableFields: ["name", "description"],
      };

      registry.registerSchema(schema);
      expect(registry.getSearchableFields("TestSchema")).toEqual(["name", "description"]);
    });
  });

  describe("getFilterableFields", () => {
    it("should return empty array for schema without filterable fields", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema);
      expect(registry.getFilterableFields("TestSchema")).toEqual([]);
    });

    it("should return filterable fields for schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        filterableFields: ["status", "category"],
      };

      registry.registerSchema(schema);
      expect(registry.getFilterableFields("TestSchema")).toEqual(["status", "category"]);
    });
  });

  describe("getSortableFields", () => {
    it("should return empty array for schema without sortable fields", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      };

      registry.registerSchema(schema);
      expect(registry.getSortableFields("TestSchema")).toEqual([]);
    });

    it("should return sortable fields for schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        sortableFields: ["createdAt", "updatedAt"],
      };

      registry.registerSchema(schema);
      expect(registry.getSortableFields("TestSchema")).toEqual(["createdAt", "updatedAt"]);
    });
  });

  describe("validateSchema", () => {
    it("should validate correct schema", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "name", dataType: ["string"], indexInverted: true }],
      };

      const result = registry.validateSchema(schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject schema without name", () => {
      const schema: SchemaConfig = {
        name: "",
        description: "Test schema",
        properties: [],
      };

      const result = registry.validateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Schema name is required");
    });

    it("should reject schema without properties", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [],
      };

      const result = registry.validateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Schema must have at least one property");
    });

    it("should reject schema with invalid vectorizer", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "name", dataType: ["string"], indexInverted: true }],
        vectorizer: { name: "", description: "Invalid vectorizer" },
      };

      const result = registry.validateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Vectorizer name is required if vectorizer is specified");
    });

    it("should reject schema with invalid properties", () => {
      const schema: SchemaConfig = {
        name: "TestSchema",
        description: "Test schema",
        properties: [
          { name: "", dataType: ["string"], indexInverted: true },
          { name: "valid", dataType: [], indexInverted: true },
        ],
      };

      const result = registry.validateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Property 0 must have a name");
      expect(result.errors).toContain("Property valid must have at least one data type");
    });
  });

  describe("getStats", () => {
    it("should return statistics", () => {
      const schema1: SchemaConfig = {
        name: "Schema1",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        metadata: { category: "test" },
      };
      const schema2: SchemaConfig = {
        name: "Schema2",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
        metadata: { category: "test" },
      };

      registry.registerSchema(schema1);
      registry.registerSchema(schema2);

      const plugin: Plugin = {
        name: "testPlugin",
        version: "1.0.0",
        description: "Test plugin",
        hooks: { beforeSearch: vi.fn(), afterSearch: vi.fn(), beforeCreate: vi.fn() },
      };
      registry.registerPlugin(plugin);

      const stats = registry.getStats();
      expect(stats.totalSchemas).toBe(2);
      expect(stats.totalPlugins).toBe(1);
      expect(stats.totalSearchMethods).toBe(3); // 3 default methods
      expect(stats.schemasByCategory.test).toBe(2);
    });
  });

  describe("clear", () => {
    it("should clear all registrations", () => {
      registry.registerSchema({
        name: "TestSchema",
        description: "Test schema",
        properties: [{ name: "id", dataType: ["string"] }],
      });

      registry.registerPlugin({
        name: "testPlugin",
        version: "1.0.0",
        description: "Test plugin",
        hooks: { beforeSearch: vi.fn(), afterSearch: vi.fn(), beforeCreate: vi.fn() },
      });

      registry.clear();

      expect(registry.getAllSchemas()).toHaveLength(0);
      expect(registry.getPlugin("testPlugin")).toBeUndefined();
      expect(registry.getAllSearchMethods()).toHaveLength(0); // All methods are cleared
    });
  });
});
