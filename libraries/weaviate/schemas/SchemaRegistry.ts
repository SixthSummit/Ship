import Logger from "@sixthsummit/ship-api/app/utils/Logger";
import type { Plugin, SchemaConfig, SearchMethod } from "../types/index.js";

export default class SchemaRegistry {
  private static instance: SchemaRegistry;
  private schemas: Map<string, SchemaConfig> = new Map();
  private plugins: Map<string, Plugin> = new Map();
  private searchMethods: Map<string, SearchMethod> = new Map();

  constructor(schemas: SchemaConfig[] = []) {
    this.registerDefaultSearchMethods();

    // Register provided schemas
    schemas.forEach((schema) => {
      this.registerSchema(schema);
    });
  }

  /**
   * Initialize the static registry with schemas
   */
  static initialize(schemas: SchemaConfig[]): void {
    SchemaRegistry.instance = new SchemaRegistry(schemas);
    Logger.log(`Static SchemaRegistry initialized with ${schemas.length} schemas`);
  }

  /**
   * Get the static registry instance
   */
  static getInstance(): SchemaRegistry {
    if (!SchemaRegistry.instance) {
      throw new Error("SchemaRegistry not initialized. Call SchemaRegistry.initialize() first.");
    }
    return SchemaRegistry.instance;
  }

  /**
   * Check if the registry is initialized
   */
  static isInitialized(): boolean {
    return SchemaRegistry.instance !== undefined;
  }

  /**
   * Register a schema configuration
   * Validates the schema before registration (fail-fast principle)
   */
  registerSchema(schema: SchemaConfig): void {
    // Validate schema before registration
    const validation = this.validateSchema(schema);
    if (!validation.valid) {
      throw new Error(
        `Schema validation failed for '${schema.name}': ${validation.errors.join(", ")}`,
      );
    }

    this.schemas.set(schema.name, schema);
    Logger.log(`Schema registered: ${schema.name}`);
  }

  /**
   * Register multiple schemas
   */
  registerSchemas(schemas: Record<string, SchemaConfig>): void {
    Object.values(schemas).forEach((schema) => {
      this.registerSchema(schema);
    });
  }

  /**
   * Get a schema by name
   */
  getSchema(name: string): SchemaConfig | undefined {
    return this.schemas.get(name);
  }

  /**
   * Get all registered schemas
   */
  getAllSchemas(): SchemaConfig[] {
    return Array.from(this.schemas.values());
  }

  /**
   * Check if a schema exists
   */
  hasSchema(name: string): boolean {
    return this.schemas.has(name);
  }

  /**
   * Get schema names
   */
  getSchemaNames(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Register a plugin
   */
  registerPlugin(plugin: Plugin): void {
    this.plugins.set(plugin.name, plugin);
    Logger.log(`Plugin registered: ${plugin.name} v${plugin.version}`);
  }

  /**
   * Get a plugin by name
   */
  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get plugins for a schema
   */
  getSchemaPlugins(schemaName: string): Plugin[] {
    const schema = this.getSchema(schemaName);
    if (!schema?.plugins) return [];

    return schema.plugins
      .map((pluginName) => this.getPlugin(pluginName))
      .filter(Boolean) as Plugin[];
  }

  /**
   * Register a search method
   */
  registerSearchMethod(method: SearchMethod): void {
    this.searchMethods.set(method.name, method);
    Logger.log(`Search method registered: ${method.name}`);
  }

  /**
   * Get a search method by name
   */
  getSearchMethod(name: string): SearchMethod | undefined {
    return this.searchMethods.get(name);
  }

  /**
   * Get all search methods
   */
  getAllSearchMethods(): SearchMethod[] {
    return Array.from(this.searchMethods.values());
  }

  /**
   * Get searchable fields for a schema
   */
  getSearchableFields(schemaName: string): string[] {
    const schema = this.getSchema(schemaName);
    return schema?.searchableFields || [];
  }

  /**
   * Get filterable fields for a schema
   */
  getFilterableFields(schemaName: string): string[] {
    const schema = this.getSchema(schemaName);
    return schema?.filterableFields || [];
  }

  /**
   * Get sortable fields for a schema
   */
  getSortableFields(schemaName: string): string[] {
    const schema = this.getSchema(schemaName);
    return schema?.sortableFields || [];
  }

  /**
   * Validate a schema configuration
   */
  validateSchema(schema: SchemaConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!schema.name) {
      errors.push("Schema name is required");
    }

    if (!schema.properties || schema.properties.length === 0) {
      errors.push("Schema must have at least one property");
    }

    if (schema.vectorizer && schema.vectorizer !== "none" && !schema.vectorizer.name) {
      errors.push("Vectorizer name is required if vectorizer is specified");
    }

    // Validate properties
    schema.properties?.forEach((prop, index) => {
      if (!prop.name) {
        errors.push(`Property ${index} must have a name`);
      }
      if (!prop.dataType || prop.dataType.length === 0) {
        errors.push(`Property ${prop.name} must have at least one data type`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get schema statistics
   */
  getStats(): {
    totalSchemas: number;
    totalPlugins: number;
    totalSearchMethods: number;
    schemasByCategory: Record<string, number>;
  } {
    const schemas = this.getAllSchemas();
    const schemasByCategory = schemas.reduce(
      (acc, schema) => {
        const category = schema.metadata?.category || "unknown";
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      totalSchemas: this.schemas.size,
      totalPlugins: this.plugins.size,
      totalSearchMethods: this.searchMethods.size,
      schemasByCategory,
    };
  }

  /**
   * Register default search methods
   */
  private registerDefaultSearchMethods(): void {
    // Vector search method
    this.registerSearchMethod({
      name: "vector",
      description: "Vector-based semantic search",
      supportedOptions: [
        "nearText",
        "nearVector",
        "nearObject",
        "where",
        "limit",
        "offset",
        "sort",
      ],
      execute: async () => {
        throw new Error("Vector search method must be implemented by the service");
      },
    });

    // BM25 search method
    this.registerSearchMethod({
      name: "bm25",
      description: "BM25 keyword-based search",
      supportedOptions: ["bm25", "where", "limit", "offset", "sort"],
      execute: async () => {
        throw new Error("BM25 search method must be implemented by the service");
      },
    });

    // Hybrid search method
    this.registerSearchMethod({
      name: "hybrid",
      description: "Hybrid search combining vector and BM25",
      supportedOptions: ["hybrid", "where", "limit", "offset", "sort"],
      execute: async () => {
        throw new Error("Hybrid search method must be implemented by the service");
      },
    });
  }

  /**
   * Clear all registrations
   */
  clear(): void {
    this.schemas.clear();
    this.plugins.clear();
    this.searchMethods.clear();
    Logger.log("Schema registry cleared");
  }
}
