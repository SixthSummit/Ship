import Logger from "@sixthsummit/ship-api/app/utils/Logger";
import { WeaviateError, WeaviateErrorCode } from "./errors/index.js";
import { createQueryBuilder, type QueryBuilder, QueryPatterns } from "./QueryBuilder.js";
import SchemaRegistry from "./schemas/SchemaRegistry.js";
import type {
  BM25SearchOptions,
  CreateTenantOptions,
  ExtendedWeaviateClient,
  HybridSearchOptions,
  Plugin,
  SchemaConfig,
  SearchableField,
  SearchOptions,
  SearchRequest,
  SearchResult,
  Tenant,
  TenantManagementResult,
  TenantStats,
  UpdateTenantOptions,
  Vectorizer,
  VectorSearchOptions,
} from "./types/index.js";
import TenantContextManager from "./utils/TenantContextManager.js";
import { WeaviateConfigService } from "./WeaviateConfig.js";

/**
 * Options for initializing a Weaviate instance
 */
export interface WeaviateOptions {
  /** Optional schema registry to use. If not provided, a new one will be created. */
  registry?: SchemaRegistry;
  /** Optional custom plugins to register. */
  plugins?: Plugin[];
}

/**
 * Main Weaviate class for vector database operations
 */
export default class Weaviate {
  private client: ExtendedWeaviateClient | null = null;
  private readonly registry: SchemaRegistry;
  private readonly defaultLimit = 25;

  /**
   * Create a new Weaviate instance
   * Client will be lazily initialized on first use
   * @param options - Optional configuration for the instance
   * @example
   * // Simple usage
   * const weaviate = new Weaviate();
   *
   * // With custom plugins
   * const weaviate = new Weaviate({
   *   plugins: [new MyCustomPlugin()]
   * });
   *
   * // For testing with mock registry
   * const mockRegistry = new SchemaRegistry();
   * const weaviate = new Weaviate({ registry: mockRegistry });
   */
  constructor(options: WeaviateOptions = {}) {
    // Use provided registry or create new one
    this.registry = options.registry || new SchemaRegistry();

    // Register custom plugins if provided
    if (options.plugins) {
      options.plugins.forEach((plugin) => {
        this.registry.registerPlugin(plugin);
      });
      Logger.log(`Weaviate initialized with ${options.plugins.length} custom plugin(s)`);
    }

    Logger.log("Weaviate instance created (client will be initialized on first use)");
  }

  /**
   * Get the Weaviate client, lazily initializing if needed
   * @private
   */
  private async getClient(skipHealthCheck = false): Promise<ExtendedWeaviateClient> {
    if (!this.client) {
      this.client = (await WeaviateConfigService.getClient(
        skipHealthCheck,
      )) as ExtendedWeaviateClient;
    }
    return this.client;
  }

  /**
   * Reset the client connection (useful after connection errors)
   * Next getClient() call will re-establish the connection
   */
  resetClient(): void {
    this.client = null;
  }

  /**
   * Initialize Weaviate schemas (call this during app startup)
   *
   * This method registers the schemas in the registry and creates them in Weaviate.
   *
   * @param schemas - Array of schema configurations to initialize
   * @example
   * const schemas = [PersonSchema, OrganizationSchema];
   * await weaviate.initializeSchemas(schemas);
   */
  async initializeSchemas(schemas: SchemaConfig[]): Promise<void> {
    try {
      Logger.log("Initializing schemas...");

      // Register schemas in the registry
      schemas.forEach((schema) => {
        this.registry.registerSchema(schema);
      });

      // Create schemas in Weaviate database
      for (const schema of schemas) {
        await this.createSchema(schema);
      }

      Logger.log(`Initialized ${schemas.length} schemas successfully`);
    } catch (error) {
      Logger.log("Error initializing schemas:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.SCHEMA_CREATION_ERROR,
        "Failed to initialize schemas",
      );
    }
  }

  /**
   * Create a schema in Weaviate
   * Note: Schema validation happens in SchemaRegistry.registerSchema (fail-fast principle)
   */
  async createSchema(schema: SchemaConfig): Promise<void> {
    try {
      // Convert to Weaviate format
      const weaviateSchema = this.convertToWeaviateSchema(schema);

      const client = await this.getClient();
      await client.collections.createFromSchema(weaviateSchema);
      Logger.log(`Schema created for class: ${schema.name}`);
    } catch (error) {
      if (error.message?.includes("already exists")) {
        Logger.log(`Schema for class ${schema.name} already exists`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Add a property to an existing schema/collection
   *
   * Use this for schema migrations when you need to add new fields
   * without recreating the entire collection.
   *
   * @param collectionName - Name of the collection (e.g., "Person")
   * @param property - Property configuration matching SearchableField interface
   * @throws Error if the property already exists or collection not found
   *
   * @example
   * await weaviate.addProperty("Person", {
   *   name: "networkUserIds",
   *   dataType: ["text[]"],
   *   description: "User IDs who have this person in their network",
   *   indexInverted: true,
   * });
   */
  async addProperty(collectionName: string, property: SearchableField): Promise<void> {
    try {
      const client = await this.getClient();
      const collection = client.collections.get(collectionName);

      // Convert SearchableField to Weaviate v3 property format
      // Note: collection.config.addProperty expects dataType as a single string, not an array
      // e.g., "text[]" not ["text[]"]
      const dataType = Array.isArray(property.dataType) ? property.dataType[0] : property.dataType;

      const weaviateProperty: Record<string, unknown> = {
        name: property.name,
        dataType,
        description: property.description,
        // Index settings - v4 uses indexFilterable/indexSearchable
        // indexInverted is legacy but may still be accepted by some versions
        indexFilterable: property.indexFilterable ?? property.indexInverted ?? true,
        indexSearchable: property.indexSearchable ?? false,
      };

      if (property.tokenization !== undefined) {
        weaviateProperty.tokenization = property.tokenization;
      }

      await collection.config.addProperty(weaviateProperty as any);
      Logger.log(`Property '${property.name}' added to collection '${collectionName}'`);
    } catch (error: any) {
      if (error.message?.includes("already exists")) {
        Logger.log(`Property '${property.name}' already exists in '${collectionName}'`);
        throw error;
      }
      Logger.log(`Error adding property '${property.name}' to '${collectionName}':`, error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.SCHEMA_CREATION_ERROR,
        `Failed to add property '${property.name}' to collection '${collectionName}'`,
      );
    }
  }

  /**
   * Type guard to check if vectorizer is a string ("none")
   */
  private isStringVectorizer(vectorizer: Vectorizer | undefined): vectorizer is "none" {
    return typeof vectorizer === "string";
  }

  /**
   * Convert schema config to Weaviate format
   */
  private convertToWeaviateSchema(schema: SchemaConfig): any {
    const weaviateSchema: any = {
      class: schema.name,
      description: schema.description,
      vectorizer: this.isStringVectorizer(schema.vectorizer)
        ? schema.vectorizer
        : schema.vectorizer?.name,
      vectorIndexConfig: schema.vectorIndexConfig,
      properties: schema.properties.map((prop) => ({
        name: prop.name,
        dataType: prop.dataType,
        description: prop.description,
        indexInverted: prop.indexInverted,
        indexFilterable: prop.indexFilterable,
        indexSearchable: prop.indexSearchable,
      })),
    };

    // Add multi-tenancy configuration if enabled
    if (schema.multiTenancy?.enabled) {
      weaviateSchema.multiTenancyConfig = {
        enabled: true,
        autoTenantCreation: schema.multiTenancy.autoTenantCreation ?? true,
        autoTenantActivation: schema.multiTenancy.autoTenantActivation ?? true,
      };
    }

    return weaviateSchema;
  }

  // ==================== SEARCH METHODS ====================

  /**
   * Generic search method with type-safe discriminated union
   *
   * @param schemaName - Name of the schema to search
   * @param request - Search request with method and options
   * @returns Search results with matching objects
   * @example
   * // Vector search
   * const results = await weaviate.search('Person', {
   *   method: 'vector',
   *   options: { nearText: { concepts: ['engineer'] }, limit: 10 }
   * });
   *
   * // BM25 search
   * const results = await weaviate.search('Person', {
   *   method: 'bm25',
   *   options: { bm25: { query: 'John Smith' }, limit: 10 }
   * });
   *
   * // Hybrid search
   * const results = await weaviate.search('Person', {
   *   method: 'hybrid',
   *   options: { hybrid: { query: 'engineer', alpha: 0.5 }, limit: 10 }
   * });
   */
  async search<T = any>(schemaName: string, request: SearchRequest): Promise<SearchResult<T>> {
    try {
      // Validate schema exists
      if (!this.registry.hasSchema(schemaName)) {
        throw new Error(`Schema '${schemaName}' not found in registry`);
      }

      // Get schema plugins
      const plugins = this.registry.getSchemaPlugins(schemaName);

      // Apply beforeSearch hooks
      let processedOptions = request.options;
      for (const plugin of plugins) {
        if (plugin.hooks.beforeSearch) {
          processedOptions = plugin.hooks.beforeSearch(schemaName, processedOptions);
        }
      }

      // Execute search based on method (TypeScript properly narrows types here)
      let result: SearchResult<T>;
      switch (request.method) {
        case "vector":
          result = await this.executeVectorSearch(schemaName, processedOptions);
          break;
        case "bm25":
          result = await this.executeBM25Search(schemaName, processedOptions);
          break;
        case "hybrid":
          result = await this.executeHybridSearch(schemaName, processedOptions);
          break;
        default:
          // Exhaustiveness check - TypeScript ensures all methods are handled
          throw new Error(`Unsupported search method`);
      }

      // Apply afterSearch hooks
      for (const plugin of plugins) {
        if (plugin.hooks.afterSearch) {
          result = plugin.hooks.afterSearch(schemaName, result);
        }
      }

      return result;
    } catch (error) {
      Logger.log(`Error searching ${schemaName} with ${request.method}:`, error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.SEARCH_ERROR,
        `Failed to search ${schemaName} with method ${request.method}`,
      );
    }
  }

  /**
   * Check if filter object is a plain object (our format) that needs conversion
   *
   * @param obj - Filter object to check
   * @returns true if plain object, false if already a FilterValue
   */
  private isPlainFilterObject(obj: any): boolean {
    return (
      obj &&
      typeof obj === "object" &&
      Object.hasOwn(obj, "path") &&
      Object.hasOwn(obj, "operator") &&
      Object.hasOwn(obj, "valueString")
    );
  }

  /**
   * Build Weaviate FilterValue from plain object using collection.filter API
   *
   * Converts our simple filter format to Weaviate v3 FilterValue objects.
   * This enables proper filtering in Weaviate instead of post-filtering in application.
   *
   * @param collection - Weaviate collection with filter builder
   * @param filterObj - Plain filter object { path, operator, valueString }
   * @returns FilterValue object for Weaviate v3 client, or undefined on error
   */
  private buildFilter(collection: any, filterObj: any): any {
    // If not a plain object, assume it's already a FilterValue
    if (!this.isPlainFilterObject(filterObj)) {
      return filterObj;
    }

    // Validate collection has filter API
    if (!collection || !collection.filter || !collection.filter.byProperty) {
      Logger.log("Warning: Collection does not have filter.byProperty API, skipping filter");
      return undefined;
    }

    const { path, operator, valueString } = filterObj;

    // Validate path
    if (!path || !Array.isArray(path) || path.length === 0) {
      Logger.log("Warning: Filter has invalid or empty path, skipping filter");
      return undefined;
    }

    const property = path[0]; // Use first element of path array

    // Validate valueString
    if (valueString === undefined || valueString === null) {
      Logger.log(`Warning: Filter has no valueString for property ${property}, skipping filter`);
      return undefined;
    }

    // Build filter using collection.filter API
    try {
      switch (operator) {
        case "ContainsAny":
          Logger.log(
            `Building ContainsAny filter for ${property} with ${Array.isArray(valueString) ? valueString.length : 1} values`,
          );
          return collection.filter.byProperty(property).containsAny(valueString);

        case "ContainsAll":
          return collection.filter.byProperty(property).containsAll(valueString);

        case "ContainsNone":
          return collection.filter.byProperty(property).containsNone(valueString);

        case "Equal":
          return collection.filter.byProperty(property).equal(valueString);

        case "NotEqual":
          return collection.filter.byProperty(property).notEqual(valueString);

        case "GreaterThan":
          return collection.filter.byProperty(property).greaterThan(valueString);

        case "GreaterThanEqual":
          return collection.filter.byProperty(property).greaterOrEqual(valueString);

        case "LessThan":
          return collection.filter.byProperty(property).lessThan(valueString);

        case "LessThanEqual":
          return collection.filter.byProperty(property).lessOrEqual(valueString);

        case "Like":
          return collection.filter.byProperty(property).like(valueString);

        case "IsNull":
          return collection.filter.byProperty(property).isNull(valueString === true);

        // Compound filters not supported in Phase 1
        case "And":
        case "Or":
        case "Not":
          Logger.log(`Warning: Compound filter ${operator} not yet supported, skipping filter`);
          return undefined;

        default:
          Logger.log(`Warning: Unsupported filter operator: ${operator}, skipping filter`);
          return undefined;
      }
    } catch (error) {
      Logger.log(`Error building filter for ${property} with operator ${operator}:`, error);
      Logger.log("Falling back to no filter");
      return undefined;
    }
  }

  /**
   * Execute vector search
   */
  private async executeVectorSearch<T>(
    schemaName: string,
    options: VectorSearchOptions,
  ): Promise<SearchResult<T>> {
    const client = await this.getClient();
    let collection = client.collections.get(schemaName);

    // Add tenant context if provided
    if (options.tenant) {
      collection = collection.withTenant(options.tenant.tenant);
    }

    // Build filter using collection.filter API if plain object provided
    const filters = options.where ? this.buildFilter(collection, options.where) : undefined;

    const queryOptions: any = {
      limit: options.limit || this.defaultLimit,
      offset: options.offset || 0,
      filters,
      returnProperties: options.fields,
      includeVector: options.includeVector,
      returnMetadata: options.includeMetadata
        ? ["certainty", "distance", "explainScore"]
        : undefined,
    };

    let result;

    // Execute the appropriate search based on what's provided
    if (options.nearText) {
      const query = Array.isArray(options.nearText.concepts)
        ? options.nearText.concepts.join(" ")
        : options.nearText.concepts || "";
      result = await collection.query.nearText(query, queryOptions);
    } else if (options.nearVector) {
      result = await collection.query.nearVector(options.nearVector.vector, queryOptions);
    } else if (options.nearObject) {
      result = await collection.query.nearObject(options.nearObject.id, queryOptions);
    } else {
      // Fallback to fetchObjects if no vector search specified
      result = await collection.query.fetchObjects(queryOptions);
    }

    return {
      objects: (result.objects || []).map((obj) => ({
        id: obj.uuid,
        properties: obj.properties as T,
        vector: this.extractVector(obj.vectors),
        certainty: obj.metadata?.certainty,
        distance: obj.metadata?.distance,
        score: obj.metadata?.score,
        metadata: obj.metadata,
      })),
      total: result.objects?.length || 0,
    };
  }

  /**
   * Execute BM25 search
   */
  private async executeBM25Search<T>(
    schemaName: string,
    options: BM25SearchOptions,
  ): Promise<SearchResult<T>> {
    const client = await this.getClient();
    let collection = client.collections.get(schemaName);

    // Add tenant context if provided
    if (options.tenant) {
      collection = collection.withTenant(options.tenant.tenant);
    }

    // Build filter using collection.filter API if plain object provided
    const filters = options.where ? this.buildFilter(collection, options.where) : undefined;

    const queryOptions: any = {
      limit: options.limit || this.defaultLimit,
      offset: options.offset || 0,
      filters,
      returnProperties: options.fields,
      includeVector: options.includeVector,
      returnMetadata: options.includeMetadata ? ["score", "explainScore"] : undefined,
    };

    // Add BM25-specific options
    if (options.bm25?.properties) {
      queryOptions.queryProperties = options.bm25.properties;
    }

    const query = options.bm25?.query || "";
    const result = await collection.query.bm25(query, queryOptions);

    return {
      objects: (result.objects || []).map((obj) => ({
        id: obj.uuid,
        properties: obj.properties as T,
        vector: this.extractVector(obj.vectors),
        certainty: obj.metadata?.certainty,
        distance: obj.metadata?.distance,
        score: obj.metadata?.score,
        metadata: obj.metadata,
      })),
      total: result.objects?.length || 0,
    };
  }

  /**
   * Execute hybrid search
   */
  private async executeHybridSearch<T>(
    schemaName: string,
    options: HybridSearchOptions,
  ): Promise<SearchResult<T>> {
    const client = await this.getClient();
    let collection = client.collections.get(schemaName);

    // Add tenant context if provided
    if (options.tenant) {
      collection = collection.withTenant(options.tenant.tenant);
    }

    // Build filter using collection.filter API if plain object provided
    const filters = options.where ? this.buildFilter(collection, options.where) : undefined;

    const queryOptions: any = {
      limit: options.limit || this.defaultLimit,
      offset: options.offset || 0,
      filters,
      returnProperties: options.fields,
      includeVector: options.includeVector,
      returnMetadata: options.includeMetadata ? ["score", "explainScore"] : undefined,
    };

    // Add hybrid-specific options
    if (options.hybrid?.alpha !== undefined) {
      queryOptions.alpha = options.hybrid.alpha;
    }
    if (options.hybrid?.properties) {
      queryOptions.queryProperties = options.hybrid.properties;
    }
    if (options.hybrid?.vector) {
      queryOptions.vector = options.hybrid.vector;
    }
    if (options.hybrid?.fusionType) {
      queryOptions.fusionType = options.hybrid.fusionType;
    }

    const query = options.hybrid?.query || "";
    const result = await collection.query.hybrid(query, queryOptions);

    return {
      objects: (result.objects || []).map((obj) => ({
        id: obj.uuid,
        properties: obj.properties as T,
        vector: this.extractVector(obj.vectors),
        certainty: obj.metadata?.certainty,
        distance: obj.metadata?.distance,
        score: obj.metadata?.score,
        metadata: obj.metadata,
      })),
      total: result.objects?.length || 0,
    };
  }

  /**
   * Extract the first vector from a Weaviate response object's vectors field.
   * Handles both v3 record format ({ default: [...] }) and array format ([[...]])
   */
  private extractVector(vectors: any): number[] | undefined {
    if (!vectors) return undefined;
    if (Array.isArray(vectors)) return vectors[0] as number[] | undefined;
    const values = Object.values(vectors);
    return values.length > 0 ? (values[0] as number[]) : undefined;
  }

  /**
   * Universal search across multiple schemas
   *
   * @param schemaNames - Array of schema names to search
   * @param request - Search request with method and options
   * @returns Record of schema names to search results
   * @example
   * const results = await weaviate.searchAll(['Person', 'Organization'], {
   *   method: 'hybrid',
   *   options: { hybrid: { query: 'engineer' }, limit: 10 }
   * });
   */
  async searchAll<T = any>(
    schemaNames: string[],
    request: SearchRequest,
  ): Promise<Record<string, SearchResult<T>>> {
    const results: Record<string, SearchResult<T>> = {};

    // Execute searches in parallel
    const searchPromises = schemaNames.map(async (schemaName) => {
      try {
        const result = await this.search<T>(schemaName, request);
        return { schemaName, result };
      } catch (error) {
        Logger.log(`Error searching ${schemaName}:`, error);
        return { schemaName, result: { objects: [], total: 0 } as SearchResult<T> };
      }
    });

    const searchResults = await Promise.all(searchPromises);

    searchResults.forEach(({ schemaName, result }) => {
      results[schemaName] = result;
    });

    return results;
  }

  /**
   * Search with automatic method selection based on query
   *
   * @param schemaName - Name of the schema to search
   * @param query - Search query
   * @param options - Additional search options
   * @returns Search results
   * @example
   * const results = await weaviate.smartSearch('Person', 'software engineer');
   */
  async smartSearch<T = any>(
    schemaName: string,
    query: string,
    options: Omit<SearchOptions, "query"> = {},
  ): Promise<SearchResult<T>> {
    // Simple heuristic: if query has quotes or specific terms, use BM25
    // Otherwise use hybrid for best results
    const hasQuotes = query.includes('"') || query.includes("'");
    const hasSpecificTerms = /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(query); // Proper names

    let method: "vector" | "bm25" | "hybrid";
    if (hasQuotes || hasSpecificTerms) {
      method = "bm25";
    } else if (query.length < 10) {
      method = "vector";
    } else {
      method = "hybrid";
    }

    Logger.log(`Smart search using ${method} method for query: "${query}"`);

    // Build proper discriminated union based on selected method
    let request: SearchRequest;
    if (method === "bm25") {
      request = {
        method: "bm25",
        options: { ...options, bm25: { query } },
      };
    } else if (method === "vector") {
      request = {
        method: "vector",
        options: { ...options, nearText: { concepts: [query] } },
      };
    } else {
      request = {
        method: "hybrid",
        options: { ...options, hybrid: { query } },
      };
    }

    return this.search<T>(schemaName, request);
  }

  /**
   * Convenience method for vector search with nearText
   *
   * @param schemaName - Name of the schema to search
   * @param concepts - Concepts to search for (semantic similarity)
   * @param options - Additional search options
   * @returns Search results with matching objects
   * @example
   * const results = await weaviate.vectorSearch('Person', ['software engineer', 'AI expert']);
   */
  async vectorSearch<T = any>(
    schemaName: string,
    concepts: string[],
    options: Omit<SearchOptions & VectorSearchOptions, "nearText"> = {},
  ): Promise<SearchResult<T>> {
    return this.search<T>(schemaName, {
      method: "vector",
      options: {
        ...options,
        nearText: { concepts },
      },
    });
  }

  /**
   * Convenience method for BM25 keyword search
   *
   * @param schemaName - Name of the schema to search
   * @param query - Text query for keyword matching
   * @param options - Additional search options
   * @returns Search results with matching objects
   * @example
   * const results = await weaviate.textSearch('Person', 'John Smith');
   */
  async textSearch<T = any>(
    schemaName: string,
    query: string,
    options: Omit<SearchOptions & BM25SearchOptions, "bm25"> = {},
  ): Promise<SearchResult<T>> {
    return this.search<T>(schemaName, {
      method: "bm25",
      options: {
        ...options,
        bm25: { query },
      },
    });
  }

  /**
   * Convenience method for hybrid search (combines vector + keyword)
   *
   * @param schemaName - Name of the schema to search
   * @param query - Search query
   * @param options - Additional search options (alpha controls the balance)
   * @returns Search results with matching objects
   * @example
   * const results = await weaviate.hybridSearch('Person', 'software engineer');
   */
  async hybridSearch<T = any>(
    schemaName: string,
    query: string,
    options: Omit<SearchOptions & HybridSearchOptions, "hybrid"> = {},
  ): Promise<SearchResult<T>> {
    return this.search<T>(schemaName, {
      method: "hybrid",
      options: {
        ...options,
        hybrid: { query },
      },
    });
  }

  /**
   * Search objects with basic options (defaults to hybrid)
   *
   * @param className - Name of the class to search
   * @param request - Search request with method and options
   * @returns Search results with matching objects
   * @example
   * const results = await weaviate.searchObjects('Person', {
   *   method: 'hybrid',
   *   options: { hybrid: { query: 'engineer' }, limit: 10 }
   * });
   */
  async searchObjects<T = any>(
    className: string,
    request: SearchRequest,
  ): Promise<SearchResult<T>> {
    return this.search<T>(className, request);
  }

  // ==================== CRUD METHODS ====================

  /**
   * Create a single object in Weaviate
   *
   * @param obj - Object to create with class and properties
   * @returns ID of the created object
   * @example
   * const id = await weaviate.createObject({
   *   class: 'Person',
   *   properties: { fullName: 'John Doe', email: 'john@example.com' }
   * });
   */
  async createObject(obj: any): Promise<string> {
    try {
      const client = await this.getClient();
      const collection = client.collections.get(obj.class);
      const result = await collection.data.insert({
        properties: obj.properties,
      });

      return result;
    } catch (error) {
      Logger.log("Error creating object:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_CREATION_ERROR,
        `Failed to create object in ${obj.class}`,
      );
    }
  }

  /**
   * Create multiple objects in batch
   */
  async createObjectsBatch(objects: any[]): Promise<string[]> {
    try {
      const client = await this.getClient();

      // Group objects by class
      const objectsByClass = objects.reduce(
        (acc, obj) => {
          if (!acc[obj.class]) {
            acc[obj.class] = [];
          }
          acc[obj.class].push(obj.properties);
          return acc;
        },
        {} as Record<string, any[]>,
      );

      // Insert each class's objects
      const ids: string[] = [];
      for (const [className, props] of Object.entries(objectsByClass)) {
        const collection = client.collections.get(className);
        const result = await collection.data.insertMany(props as any);
        if (result.uuids) {
          ids.push(...Object.values(result.uuids));
        }
      }

      return ids;
    } catch (error) {
      Logger.log("Error creating objects batch:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.BATCH_OPERATION_ERROR,
        "Failed to create batch of objects",
      );
    }
  }

  /**
   * Create an object with a custom vector
   */
  async createObjectWithVector(
    className: string,
    properties: any,
    vector: number[],
    id?: string,
    tenant?: string,
  ): Promise<string> {
    try {
      const client = await this.getClient();
      let collection = client.collections.get(className);

      // Add tenant context if provided
      if (tenant) {
        collection = collection.withTenant(tenant);
      }

      const result = await collection.data.insert({
        properties,
        vectors: vector,
        ...(id && { id }),
      });

      return result;
    } catch (error) {
      Logger.log("Error creating object with vector:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_CREATION_ERROR,
        `Failed to create object with vector in ${className}`,
      );
    }
  }

  /**
   * Get an object by ID
   */
  async getObject<T = any>(
    className: string,
    objectId: string,
    tenant?: string,
  ): Promise<T | null> {
    try {
      const client = await this.getClient();
      let collection = client.collections.get(className);

      // Add tenant context if provided
      if (tenant) {
        collection = collection.withTenant(tenant);
      }

      const result = await collection.query.fetchObjectById(objectId);

      return (result?.properties as T) || null;
    } catch (error) {
      Logger.log("Error getting object:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_RETRIEVAL_ERROR,
        `Failed to get object ${objectId} from ${className}`,
      );
    }
  }

  /**
   * Update an object
   */
  async updateObject(className: string, objectId: string, properties: any): Promise<void> {
    try {
      const client = await this.getClient();
      const collection = client.collections.get(className);
      await collection.data.update({
        id: objectId,
        properties,
      });
    } catch (error) {
      Logger.log("Error updating object:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_UPDATE_ERROR,
        `Failed to update object ${objectId} in ${className}`,
      );
    }
  }

  /**
   * Update an object with tenant support (properties only, no vector)
   */
  async updateObjectWithTenant(
    className: string,
    objectId: string,
    properties: any,
    tenant?: string,
    skipHealthCheck = false,
  ): Promise<void> {
    try {
      // Skip health check for batch operations - they handle their own retries
      const client = await this.getClient(skipHealthCheck);
      let collection = client.collections.get(className);

      // Add tenant context if provided
      if (tenant) {
        collection = collection.withTenant(tenant);
      }

      await collection.data.update({
        id: objectId,
        properties,
      });
    } catch (error) {
      Logger.log("Error updating object with tenant:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_UPDATE_ERROR,
        `Failed to update object ${objectId} in ${className}`,
      );
    }
  }

  /**
   * Update an object with a custom vector
   */
  async updateObjectWithVector(
    className: string,
    objectId: string,
    properties: any,
    vector: number[],
    tenant?: string,
  ): Promise<void> {
    try {
      const client = await this.getClient();
      let collection = client.collections.get(className);

      // Add tenant context if provided
      if (tenant) {
        collection = collection.withTenant(tenant);
      }

      await collection.data.update({
        id: objectId,
        properties,
        vectors: vector,
      });
    } catch (error) {
      Logger.log("Error updating object with vector:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_UPDATE_ERROR,
        `Failed to update object ${objectId} with vector in ${className}`,
      );
    }
  }

  /**
   * Delete an object
   */
  async deleteObject(className: string, objectId: string): Promise<void> {
    try {
      const client = await this.getClient();
      const collection = client.collections.get(className);
      await collection.data.deleteById(objectId);
    } catch (error) {
      Logger.log("Error deleting object:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_DELETE_ERROR,
        `Failed to delete object ${objectId} from ${className}`,
      );
    }
  }

  /**
   * Get object count for a class
   */
  async getObjectCount(className: string): Promise<number> {
    try {
      const client = await this.getClient();
      const collection = client.collections.get(className);
      const count = await collection.aggregate.overAll();
      return count.totalCount || 0;
    } catch (error) {
      Logger.log("Error getting object count:", error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.OBJECT_RETRIEVAL_ERROR,
        `Failed to get object count for ${className}`,
      );
    }
  }

  // ==================== MULTI-TENANCY METHODS ====================

  /**
   * Create a new tenant for a multi-tenant collection
   *
   * @param className - Name of the multi-tenant class
   * @param options - Tenant creation options (name, activityStatus)
   * @returns Result with success status and tenant information
   * @example
   * const result = await weaviate.createTenant('UserDocuments', {
   *   name: 'acme-corp',
   *   activityStatus: 'HOT'
   * });
   */
  async createTenant(
    className: string,
    options: CreateTenantOptions,
  ): Promise<TenantManagementResult> {
    try {
      // Validate tenant name format
      if (!TenantContextManager.validateTenantName(options.name)) {
        const sanitized = TenantContextManager.sanitizeTenantName(options.name);
        throw new Error(
          `Invalid tenant name '${options.name}'. Tenant names must be lowercase alphanumeric with hyphens only (max 63 chars). Suggested: '${sanitized}'`,
        );
      }

      const client = await this.getClient();
      const collection = client.collections.get(className);
      await collection.tenants.create({
        name: options.name,
        activityStatus: options.activityStatus || "HOT",
      });

      Logger.log(`Tenant '${options.name}' created for class '${className}'`);

      return {
        success: true,
        tenant: {
          name: options.name,
          activityStatus: options.activityStatus || "HOT",
        },
      };
    } catch (error) {
      Logger.log(`Error creating tenant '${options.name}':`, error);
      return {
        success: false,
        error: error.message || "Failed to create tenant",
      };
    }
  }

  /**
   * List all tenants for a multi-tenant collection
   */
  async listTenants(className: string): Promise<Tenant[]> {
    try {
      const client = await this.getClient();
      const collection = client.collections.get(className);
      const result = await collection.tenants.get();

      return Object.values(result).map((tenant: any) => ({
        name: tenant.name,
        activityStatus: tenant.activityStatus,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
      }));
    } catch (error) {
      Logger.log(`Error listing tenants for class '${className}':`, error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.TENANT_RETRIEVAL_ERROR,
        `Failed to list tenants for ${className}`,
      );
    }
  }

  /**
   * Get a specific tenant
   */
  async getTenant(className: string, tenantName: string): Promise<Tenant | null> {
    try {
      const tenants = await this.listTenants(className);
      return tenants.find((tenant) => tenant.name === tenantName) || null;
    } catch (error) {
      Logger.log(`Error getting tenant '${tenantName}':`, error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.TENANT_RETRIEVAL_ERROR,
        `Failed to get tenant '${tenantName}' from ${className}`,
      );
    }
  }

  /**
   * Update a tenant
   */
  async updateTenant(
    className: string,
    tenantName: string,
    options: UpdateTenantOptions,
  ): Promise<TenantManagementResult> {
    try {
      // Validate tenant name format
      if (!TenantContextManager.validateTenantName(tenantName)) {
        throw new Error(
          `Invalid tenant name '${tenantName}'. Tenant names must be lowercase alphanumeric with hyphens only (max 63 chars).`,
        );
      }

      const client = await this.getClient();
      const collection = client.collections.get(className);
      await collection.tenants.update({
        name: tenantName,
        activityStatus: options.activityStatus as "HOT" | "COLD" | "FROZEN" | undefined,
      });

      Logger.log(`Tenant '${tenantName}' updated for class '${className}'`);

      return {
        success: true,
        tenant: {
          name: tenantName,
          activityStatus: options.activityStatus || "HOT",
        },
      };
    } catch (error) {
      Logger.log(`Error updating tenant '${tenantName}':`, error);
      return {
        success: false,
        error: error.message || "Failed to update tenant",
      };
    }
  }

  /**
   * Delete a tenant
   */
  async deleteTenant(className: string, tenantName: string): Promise<TenantManagementResult> {
    try {
      // Validate tenant name format
      if (!TenantContextManager.validateTenantName(tenantName)) {
        throw new Error(
          `Invalid tenant name '${tenantName}'. Tenant names must be lowercase alphanumeric with hyphens only (max 63 chars).`,
        );
      }

      const client = await this.getClient();
      const collection = client.collections.get(className);
      await collection.tenants.remove(tenantName);

      Logger.log(`Tenant '${tenantName}' deleted from class '${className}'`);

      return {
        success: true,
      };
    } catch (error) {
      Logger.log(`Error deleting tenant '${tenantName}':`, error);
      return {
        success: false,
        error: error.message || "Failed to delete tenant",
      };
    }
  }

  /**
   * Get tenant statistics for a collection
   */
  async getTenantStats(className: string): Promise<TenantStats> {
    try {
      const tenants = await this.listTenants(className);

      return {
        totalTenants: tenants.length,
        activeTenants: tenants.filter((t) => t.activityStatus === "HOT").length,
        inactiveTenants: tenants.filter((t) => t.activityStatus === "INACTIVE").length,
        coldTenants: tenants.filter((t) => t.activityStatus === "COLD").length,
      };
    } catch (error) {
      Logger.log(`Error getting tenant stats for class '${className}':`, error);
      throw WeaviateError.from(
        error,
        WeaviateErrorCode.TENANT_RETRIEVAL_ERROR,
        `Failed to get tenant stats for ${className}`,
      );
    }
  }

  /**
   * Check if a collection supports multi-tenancy
   */
  async isMultiTenant(className: string): Promise<boolean> {
    try {
      const client = await this.getClient();
      const config = await client.collections.export(className);
      return config.multiTenancy?.enabled || false;
    } catch (error) {
      Logger.log(`Error checking multi-tenancy for class '${className}':`, error);
      return false;
    }
  }

  /**
   * Search with tenant context
   *
   * @param schemaName - Name of the schema to search
   * @param request - Search request with method and options
   * @param tenant - Tenant identifier
   * @returns Search results scoped to the specified tenant
   * @example
   * const results = await weaviate.searchWithTenant('Person', {
   *   method: 'hybrid',
   *   options: { hybrid: { query: 'engineer' }, limit: 10 }
   * }, 'tenant123');
   */
  async searchWithTenant<T = any>(
    schemaName: string,
    request: SearchRequest,
    tenant: string,
  ): Promise<SearchResult<T>> {
    // Validate tenant name format
    if (!TenantContextManager.validateTenantName(tenant)) {
      throw new Error(
        `Invalid tenant name '${tenant}'. Tenant names must be lowercase alphanumeric with hyphens only (max 63 chars).`,
      );
    }

    // Add tenant to the options
    const requestWithTenant: SearchRequest = {
      method: request.method,
      options: {
        ...request.options,
        tenant: { tenant },
      },
    } as SearchRequest;

    return this.search<T>(schemaName, requestWithTenant);
  }

  /**
   * Smart search with tenant context
   */
  async smartSearchWithTenant<T = any>(
    schemaName: string,
    query: string,
    tenant: string,
    options: Omit<SearchOptions, "query" | "tenant"> = {},
  ): Promise<SearchResult<T>> {
    return this.smartSearch<T>(schemaName, query, {
      ...options,
      tenant: { tenant },
    });
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Create a query builder for a specific schema
   */
  queryBuilder(schemaName: string): QueryBuilder {
    return createQueryBuilder(schemaName);
  }

  /**
   * Get query patterns for common operations
   */
  get patterns() {
    return QueryPatterns;
  }

  /**
   * Get schema information
   */
  getSchemaInfo(schemaName: string): {
    schema: SchemaConfig | undefined;
    searchableFields: string[];
    filterableFields: string[];
    sortableFields: string[];
    plugins: Plugin[];
  } {
    return {
      schema: this.registry.getSchema(schemaName),
      searchableFields: this.registry.getSearchableFields(schemaName),
      filterableFields: this.registry.getFilterableFields(schemaName),
      sortableFields: this.registry.getSortableFields(schemaName),
      plugins: this.registry.getSchemaPlugins(schemaName),
    };
  }

  /**
   * Get service statistics
   */
  getStats(): {
    registry: ReturnType<SchemaRegistry["getStats"]>;
    schemas: string[];
  } {
    return {
      registry: this.registry.getStats(),
      schemas: this.registry.getSchemaNames(),
    };
  }

  /**
   * Get the schema registry
   */
  getRegistry(): SchemaRegistry {
    return this.registry;
  }

  /**
   * Register a custom schema in the registry (without creating in Weaviate)
   *
   * @param schema - Schema configuration to register
   * @example
   * weaviate.registerSchema(ProductSchema);
   */
  registerSchema(schema: SchemaConfig): void {
    this.registry.registerSchema(schema);
  }

  /**
   * Register multiple schemas at once
   *
   * @param schemas - Record of schema configurations to register
   */
  registerSchemas(schemas: Record<string, SchemaConfig>): void {
    this.registry.registerSchemas(schemas);
  }

  /**
   * Register a custom plugin for schema operations
   *
   * @param plugin - Plugin to register
   * @example
   * weaviate.registerPlugin(new MyCustomPlugin());
   */
  registerPlugin(plugin: Plugin): void {
    this.registry.registerPlugin(plugin);
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.getMeta();
      return true;
    } catch (error) {
      Logger.log("Weaviate health check failed:", error);
      return false;
    }
  }
}
