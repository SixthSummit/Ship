# API Reference

Complete reference for all Weaviate framework methods, types, and interfaces.

## 🏗️ Core Classes

### Weaviate

Main framework class for vector search operations.

```typescript
import Weaviate from "./Weaviate.js";

const weaviate = new Weaviate();
```

#### Constructor

```typescript
constructor(options?: WeaviateOptions);
```

Creates a new Weaviate instance.

**Options:**
- `registry?`: Custom SchemaRegistry instance (optional)
- `plugins?`: Array of custom plugins to register (optional)

The client is lazily initialized on first use via `WeaviateConfigService`.

#### Methods

##### `initializeSchemas(schemas: SchemaConfig[]): Promise<void>`

Initialize schemas in Weaviate. Registers schemas in the registry and creates them in the database.

```typescript
await weaviate.initializeSchemas([PersonSchema, OrganizationSchema]);
```

**Parameters:**

- `schemas`: Array of schema configurations

**Returns:** Promise that resolves when schemas are initialized

##### `search<T>(schemaName: string, request: SearchRequest): Promise<SearchResult<T>>`

Generic search method with type-safe discriminated union.

```typescript
// Vector search
const results = await weaviate.search("Person", {
  method: "vector",
  options: {
    nearText: { concepts: ["engineer"], certainty: 0.7 },
    limit: 10
  }
});

// BM25 search
const results = await weaviate.search("Person", {
  method: "bm25",
  options: {
    bm25: { query: "software engineer" },
    limit: 10
  }
});

// Hybrid search
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "machine learning expert", alpha: 0.5 },
    limit: 10
  }
});
```

**Parameters:**

- `schemaName`: Name of the schema to search
- `request`: Search request object with discriminated union
  - `method`: Search method ("vector", "bm25", "hybrid")
  - `options`: Search options specific to the method

**Returns:** Promise resolving to search results

##### `smartSearch<T>(schemaName: string, query: string, options?: Omit<SearchOptions, "query">): Promise<SearchResult<T>>`

Smart search with automatic method selection.

```typescript
const results = await weaviate.smartSearch("Person", "machine learning expert", {
  limit: 10,
});
```

**Parameters:**

- `schemaName`: Name of the schema to search
- `query`: Search query string
- `options`: Optional search options

**Returns:** Promise resolving to search results

##### `searchAll<T>(schemaNames: string[], request: SearchRequest): Promise<Record<string, SearchResult<T>>>`

Search across multiple schemas.

```typescript
const results = await weaviate.searchAll(["Person", "Organization", "Conversation"], {
  method: "hybrid",
  options: {
    hybrid: { query: "AI", alpha: 0.6 },
    limit: 5
  }
});
```

**Parameters:**

- `schemaNames`: Array of schema names to search
- `request`: Search request object with discriminated union
  - `method`: Search method ("vector", "bm25", "hybrid")
  - `options`: Search options specific to the method

**Returns:** Promise resolving to results object with schema names as keys

##### `vectorSearch<T>(schemaName: string, concepts: string[], options?: Omit<SearchOptions & VectorSearchOptions, "nearText">): Promise<SearchResult<T>>`

Convenience method for vector search.

```typescript
const results = await weaviate.vectorSearch("Person", ["engineer", "developer"], {
  certainty: 0.8,
  limit: 10,
});
```

##### `textSearch<T>(schemaName: string, query: string, options?: Omit<SearchOptions & BM25SearchOptions, "bm25">): Promise<SearchResult<T>>`

Convenience method for BM25 text search.

```typescript
const results = await weaviate.textSearch("Person", "software engineer", {
  limit: 10,
});
```

##### `hybridSearch<T>(schemaName: string, query: string, options?: Omit<SearchOptions & HybridSearchOptions, "hybrid">): Promise<SearchResult<T>>`

Convenience method for hybrid search.

```typescript
const results = await weaviate.hybridSearch("Person", "AI researcher", {
  alpha: 0.5,
  limit: 10,
});
```

##### `queryBuilder(schemaName: string): QueryBuilder`

Create a query builder for a specific schema.

```typescript
const query = weaviate
  .queryBuilder("Person")
  .limit(10)
  .whereField("city", "Equal", "San Francisco")
  .sort("createdAt", "desc");
```

**Returns:** QueryBuilder instance

##### `getSchemaInfo(schemaName: string): any`

Get schema information.

```typescript
const info = weaviate.getSchemaInfo("Person");
```

**Returns:** Schema information object

##### `getStats(): any`

Get service statistics.

```typescript
const stats = weaviate.getStats();
```

**Returns:** Statistics object

##### `healthCheck(): Promise<boolean>`

Check if the service is healthy.

```typescript
const isHealthy = await weaviate.healthCheck();
```

**Returns:** Promise resolving to boolean

##### `resetClient(): void`

Reset the client connection. Useful after connection errors - next getClient() call will re-establish the connection.

```typescript
weaviate.resetClient();
```

##### `addProperty(collectionName: string, property: SearchableField): Promise<void>`

Add a property to an existing schema/collection. Use this for schema migrations when adding new fields.

```typescript
await weaviate.addProperty("Person", {
  name: "networkUserIds",
  dataType: ["text[]"],
  description: "User IDs who have this person in their network",
  indexInverted: true,
});
```

**Parameters:**
- `collectionName`: Name of the collection (e.g., "Person")
- `property`: Property configuration

**Throws:** Error if property already exists or collection not found

##### `registerSchema(schema: SchemaConfig): void`

Register a custom schema.

```typescript
weaviate.registerSchema(customSchema);
```

##### `registerPlugin(plugin: any): void`

Register a custom plugin.

```typescript
weaviate.registerPlugin(new MyCustomPlugin());
```

##### `getRegistry(): SchemaRegistry`

Get the schema registry.

```typescript
const registry = weaviate.getRegistry();
```

**Returns:** SchemaRegistry instance

### Multi-Tenancy Methods

##### `createTenant(className: string, options: CreateTenantOptions): Promise<TenantManagementResult>`

Create a new tenant for a multi-tenant collection.

```typescript
const result = await weaviate.createTenant("UserDocuments", {
  name: "acme-corp",
  activityStatus: "HOT",
});
```

**Parameters:**

- `className`: Name of the collection
- `options`: Tenant creation options

**Returns:** Promise resolving to tenant management result

##### `listTenants(className: string): Promise<Tenant[]>`

List all tenants for a multi-tenant collection.

```typescript
const tenants = await weaviate.listTenants("UserDocuments");
```

**Parameters:**

- `className`: Name of the collection

**Returns:** Promise resolving to array of tenants

##### `getTenant(className: string, tenantName: string): Promise<Tenant | null>`

Get a specific tenant.

```typescript
const tenant = await weaviate.getTenant("UserDocuments", "acme-corp");
```

**Parameters:**

- `className`: Name of the collection
- `tenantName`: Name of the tenant

**Returns:** Promise resolving to tenant or null

##### `updateTenant(className: string, tenantName: string, options: UpdateTenantOptions): Promise<TenantManagementResult>`

Update a tenant.

```typescript
const result = await weaviate.updateTenant("UserDocuments", "acme-corp", {
  activityStatus: "COLD",
});
```

**Parameters:**

- `className`: Name of the collection
- `tenantName`: Name of the tenant
- `options`: Update options

**Returns:** Promise resolving to tenant management result

##### `deleteTenant(className: string, tenantName: string): Promise<TenantManagementResult>`

Delete a tenant.

```typescript
const result = await weaviate.deleteTenant("UserDocuments", "acme-corp");
```

**Parameters:**

- `className`: Name of the collection
- `tenantName`: Name of the tenant

**Returns:** Promise resolving to tenant management result

##### `getTenantStats(className: string): Promise<TenantStats>`

Get tenant statistics for a collection.

```typescript
const stats = await weaviate.getTenantStats("UserDocuments");
```

**Parameters:**

- `className`: Name of the collection

**Returns:** Promise resolving to tenant statistics

##### `isMultiTenant(className: string): Promise<boolean>`

Check if a collection supports multi-tenancy.

```typescript
const isMultiTenant = await weaviate.isMultiTenant("UserDocuments");
```

**Parameters:**

- `className`: Name of the collection

**Returns:** Promise resolving to boolean

##### `searchWithTenant<T>(schemaName: string, request: SearchRequest, tenant: string): Promise<SearchResult<T>>`

Search with tenant context.

```typescript
const results = await weaviate.searchWithTenant(
  "UserDocuments",
  {
    method: "hybrid",
    options: {
      hybrid: { query: "machine learning", alpha: 0.5 }
    }
  },
  "acme-corp"
);
```

**Parameters:**

- `schemaName`: Name of the schema
- `request`: Search request object with discriminated union
  - `method`: Search method ("vector", "bm25", "hybrid")
  - `options`: Search options specific to the method
- `tenant`: Tenant name

**Returns:** Promise resolving to search results

##### `smartSearchWithTenant<T>(schemaName: string, query: string, tenant: string, options?: Omit<SearchOptions, "query" | "tenant">): Promise<SearchResult<T>>`

Smart search with tenant context.

```typescript
const results = await weaviate.smartSearchWithTenant("UserDocuments", "AI expert", "acme-corp");
```

**Parameters:**

- `schemaName`: Name of the schema
- `query`: Search query
- `tenant`: Tenant name
- `options`: Optional search options

**Returns:** Promise resolving to search results

## 💾 CRUD Operations

##### `createObject(obj: { class: string; properties: any }): Promise<string>`

Create a single object in Weaviate.

```typescript
const id = await weaviate.createObject({
  class: "Person",
  properties: { fullName: "John Doe", email: "john@example.com" }
});
```

**Returns:** Promise resolving to the created object's ID

##### `createObjectsBatch(objects: Array<{ class: string; properties: any }>): Promise<string[]>`

Create multiple objects in batch.

```typescript
const ids = await weaviate.createObjectsBatch([
  { class: "Person", properties: { fullName: "Alice" } },
  { class: "Person", properties: { fullName: "Bob" } }
]);
```

**Returns:** Promise resolving to array of created object IDs

##### `createObjectWithVector(className: string, properties: any, vector: number[], id?: string, tenant?: string): Promise<string>`

Create an object with a custom vector.

```typescript
const id = await weaviate.createObjectWithVector(
  "Person",
  { fullName: "John Doe" },
  [0.1, 0.2, 0.3, ...], // embedding vector
  "custom-uuid",        // optional ID
  "tenant-123"          // optional tenant
);
```

**Returns:** Promise resolving to the created object's ID

##### `getObject<T>(className: string, objectId: string, tenant?: string): Promise<T | null>`

Get an object by ID.

```typescript
const person = await weaviate.getObject<Person>("Person", "uuid-123");
const tenantPerson = await weaviate.getObject<Person>("Person", "uuid-123", "tenant-123");
```

**Returns:** Promise resolving to the object or null

##### `updateObject(className: string, objectId: string, properties: any): Promise<void>`

Update an object's properties.

```typescript
await weaviate.updateObject("Person", "uuid-123", {
  email: "newemail@example.com"
});
```

##### `updateObjectWithTenant(className: string, objectId: string, properties: any, tenant?: string, skipHealthCheck?: boolean): Promise<void>`

Update an object with tenant support.

```typescript
await weaviate.updateObjectWithTenant("Person", "uuid-123", { email: "new@example.com" }, "tenant-123");
```

##### `updateObjectWithVector(className: string, objectId: string, properties: any, vector: number[], tenant?: string): Promise<void>`

Update an object with a new vector.

```typescript
await weaviate.updateObjectWithVector(
  "Person",
  "uuid-123",
  { fullName: "Updated Name" },
  [0.2, 0.3, 0.4, ...],
  "tenant-123"
);
```

##### `deleteObject(className: string, objectId: string): Promise<void>`

Delete an object by ID.

```typescript
await weaviate.deleteObject("Person", "uuid-123");
```

##### `getObjectCount(className: string): Promise<number>`

Get the total count of objects in a class.

```typescript
const count = await weaviate.getObjectCount("Person");
console.log(`Total people: ${count}`);
```

**Returns:** Promise resolving to the count

## 🔧 QueryBuilder

Fluent API for building complex queries.

```typescript
import { QueryBuilder, createQueryBuilder } from "./QueryBuilder.js";

const query = createQueryBuilder("Person");
```

### Methods

##### `limit(count: number): QueryBuilder`

Set the maximum number of results.

```typescript
query.limit(10);
```

##### `offset(count: number): QueryBuilder`

Set the number of results to skip.

```typescript
query.offset(20);
```

##### `whereField(field: string, operator: string, value: any): QueryBuilder`

Add a field filter.

```typescript
query.whereField("city", "Equal", "San Francisco");
query.whereField("age", "GreaterThan", 25);
```

**Supported operators:**

- `Equal`, `NotEqual`
- `GreaterThan`, `GreaterThanEqual`
- `LessThan`, `LessThanEqual`
- `Like`, `NotLike`
- `In`, `NotIn`

##### `sort(field: string, direction: "asc" | "desc"): QueryBuilder`

Add sorting.

```typescript
query.sort("createdAt", "desc");
```

##### `buildVectorSearch(concepts: string[], options?: VectorSearchOptions): SearchOptions`

Build vector search options.

```typescript
const options = query.buildVectorSearch(["engineer", "developer"], {
  certainty: 0.8,
});
```

##### `buildBM25Search(query: string, options?: BM25SearchOptions): SearchOptions`

Build BM25 search options.

```typescript
const options = query.buildBM25Search("software engineer");
```

##### `buildHybridSearch(query: string, options?: HybridSearchOptions): SearchOptions`

Build hybrid search options.

```typescript
const options = query.buildHybridSearch("AI researcher", {
  alpha: 0.5,
});
```

## 🎯 QueryPatterns

Pre-built query patterns for common operations.

```typescript
import { QueryPatterns } from "./QueryBuilder.js";
```

### Methods

##### `dateRange(field: string, startDate: Date, endDate: Date): any`

Create a date range filter.

```typescript
const dateFilter = QueryPatterns.dateRange("createdAt", startDate, endDate);
```

##### `textContains(field: string, value: string): any`

Create a text contains filter.

```typescript
const textFilter = QueryPatterns.textContains("bio", "engineer");
```

##### `exactMatch(field: string, value: any): any`

Create an exact match filter.

```typescript
const exactFilter = QueryPatterns.exactMatch("email", "john@example.com");
```

##### `arrayContains(field: string, value: any): any`

Create an array contains filter.

```typescript
const arrayFilter = QueryPatterns.arrayContains("skills", "JavaScript");
```

## 🔧 WeaviateConfigService

Configuration service for Weaviate client.

```typescript
import { WeaviateConfigService } from "./WeaviateConfig.js";
```

### Methods

##### `static initializeClient(config?: WeaviateConfig): Promise<WeaviateClient>`

Initialize Weaviate client.

```typescript
const client = await WeaviateConfigService.initializeClient();
```

**Parameters:**

- `config`: Optional custom configuration

**Returns:** Promise resolving to WeaviateClient

##### `static async getClient(skipHealthCheck?: boolean): Promise<WeaviateClient>`

Get the initialized client with optional health check. Lazily initializes if not already done.

```typescript
const client = await WeaviateConfigService.getClient();

// Skip health check for batch operations
const client = await WeaviateConfigService.getClient(true);
```

**Parameters:**
- `skipHealthCheck`: Skip periodic health check (default: `false`)

**Returns:** Promise resolving to WeaviateClient instance

##### `static getClientSync(): WeaviateClient`

Get the initialized client synchronously (without health check). Throws if not initialized.

```typescript
const client = WeaviateConfigService.getClientSync();
```

**Returns:** WeaviateClient instance

**Throws:** Error if client not initialized

##### `static healthCheck(): Promise<boolean>`

Check client health.

```typescript
const isHealthy = await WeaviateConfigService.healthCheck();
```

**Returns:** Promise resolving to boolean

##### `static getClusterInfo(): Promise<any>`

Get cluster information.

```typescript
const info = await WeaviateConfigService.getClusterInfo();
```

**Returns:** Promise resolving to cluster info

##### `static resetClient(): void`

Reset the client (useful for testing).

```typescript
WeaviateConfigService.resetClient();
```

## 📊 Types and Interfaces

### SearchOptions

Base interface for all search options.

```typescript
interface SearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  where?: Record<string, any>;
  sort?: Array<{ field: string; order: "asc" | "desc" }>;
  fields?: string[];           // Specific fields to return
  includeVector?: boolean;
  includeMetadata?: boolean;
  tenant?: TenantContext;      // Tenant context for multi-tenant operations
}
```

### VectorSearchOptions

Options for vector search (extends SearchOptions).

```typescript
interface VectorSearchOptions extends SearchOptions {
  nearText?: {
    concepts: string[];
    certainty?: number;
    moveAwayFrom?: { concepts: string[]; force: number };
    moveTo?: { concepts: string[]; force: number };
  };
  nearVector?: {
    vector: number[];
    certainty?: number;
  };
  nearObject?: {
    id: string;
    certainty?: number;
  };
}
```

### BM25SearchOptions

Options for BM25 keyword search (extends SearchOptions).

```typescript
interface BM25SearchOptions extends SearchOptions {
  bm25?: {
    query: string;
    properties?: string[];
    boost?: number;
  };
}
```

### HybridSearchOptions

Options for hybrid search combining vector and BM25 (extends SearchOptions).

```typescript
interface HybridSearchOptions extends SearchOptions {
  hybrid?: {
    query: string;
    alpha?: number;           // 0 = pure BM25, 1 = pure vector
    properties?: string[];
    vector?: number[];
    fusionType?: "RelativeScore" | "Ranked";
  };
}
```

### SearchResult

Result structure for search operations.

```typescript
interface SearchResult<T = any> {
  objects: Array<{
    id: string;
    properties: T;
    vector?: number[];
    certainty?: number;
    distance?: number;
    score?: number;
    metadata?: {
      explainScore?: string;
      [key: string]: any;
    };
  }>;
  total?: number;
  took?: number;
}
```

### SchemaConfig

Schema configuration interface.

```typescript
interface SchemaConfig {
  name: string;
  description?: string;
  vectorizer?: Vectorizer;
  vectorIndexConfig?: VectorIndexConfig;
  properties: SearchableField[];
  searchableFields?: string[];
  filterableFields?: string[];
  sortableFields?: string[];
  relationships?: {
    [fieldName: string]: {
      targetClass: string;
      type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
      required?: boolean;
    };
  };
  plugins?: string[];
  metadata?: Record<string, any>;
  multiTenancy?: MultiTenancyConfig;
}
```

### Multi-Tenancy Types

#### MultiTenancyConfig

Multi-tenancy configuration for schemas.

```typescript
interface MultiTenancyConfig {
  enabled: boolean;
  autoTenantCreation?: boolean;
  autoTenantActivation?: boolean;
}
```

#### Tenant

Tenant information.

```typescript
interface Tenant {
  name: string;
  status: "ACTIVE" | "INACTIVE" | "COLD";
  activityStatus?: "HOT" | "WARM" | "COLD";
  createdAt?: string;
  updatedAt?: string;
}
```

#### CreateTenantOptions

Options for creating a tenant.

```typescript
interface CreateTenantOptions {
  name: string;
  activityStatus?: "HOT" | "WARM" | "COLD";
}
```

#### UpdateTenantOptions

Options for updating a tenant.

```typescript
interface UpdateTenantOptions {
  activityStatus?: "HOT" | "WARM" | "COLD";
}
```

#### TenantContext

Tenant context for operations.

```typescript
interface TenantContext {
  tenant: string;
  activityStatus?: "HOT" | "WARM" | "COLD";
}
```

#### TenantStats

Tenant statistics.

```typescript
interface TenantStats {
  totalTenants: number;
  activeTenants: number;
  inactiveTenants: number;
  coldTenants: number;
}
```

#### TenantManagementResult

Result of tenant management operations.

```typescript
interface TenantManagementResult {
  success: boolean;
  tenant?: Tenant;
  error?: string;
}
```

### SearchableField

Field configuration interface for Weaviate schema properties.

```typescript
interface SearchableField {
  /** The name of the field in the Weaviate schema */
  name: string;
  
  /** Array of data types that this field can contain (e.g., ['string', 'text']) */
  dataType: string[];
  
  /** Optional human-readable description of what this field represents */
  description?: string;
  
  /** Whether to create an inverted index for this field (enables full-text search) */
  indexInverted?: boolean;
  
  /** Whether this field can be used in filter operations (WHERE clauses) */
  indexFilterable?: boolean;
  
  /** Whether this field is included in search operations */
  indexSearchable?: boolean;
  
  /** Weight for BM25 scoring algorithm (higher = more important) */
  weight?: number;
  
  /** Boost factor for vector search similarity scores */
  boost?: number;
  
  /** Tokenization method for text fields */
  tokenization?: "field" | "word" | "lowercase" | "whitespace";
}
```

### Plugin

Plugin interface for extending Weaviate functionality.

```typescript
interface Plugin {
  /** Unique plugin identifier */
  name: string;
  
  /** Plugin version string */
  version: string;
  
  /** Optional human-readable description */
  description?: string;
  
  /** List of schema names this plugin applies to (empty = all schemas) */
  schemas?: string[];
  
  /** Hook functions for intercepting operations */
  hooks: {
    /** Called before search operations - can modify search options */
    beforeSearch?: (schemaName: string, options: SearchOptions) => SearchOptions;
    
    /** Called after search operations - can modify results */
    afterSearch?: <T>(schemaName: string, result: SearchResult<T>) => SearchResult<T>;
    
    /** Called before object creation */
    beforeCreate?: (schemaName: string, data: any) => any;
    
    /** Called after object creation */
    afterCreate?: (schemaName: string, data: any, id: string) => void;
  };
}
```

## 🚀 Usage Examples

### Basic Search

```typescript
// Initialize
await WeaviateConfigService.initializeClient();
const weaviate = new Weaviate();
await weaviate.initializeSchemas(schemas);

// Search using discriminated union pattern
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "software engineer", alpha: 0.5 },
    limit: 10,
  }
});
```

### Advanced Query Building

```typescript
const query = weaviate
  .queryBuilder("Person")
  .limit(10)
  .whereField("city", "Equal", "San Francisco")
  .whereField("age", "GreaterThan", 25)
  .sort("createdAt", "desc");

const results = await weaviate.search("Person", {
  method: "hybrid",
  options: query.buildHybridSearch("engineer", { alpha: 0.6 }),
});
```

### Multi-Schema Search

```typescript
const results = await weaviate.searchAll(["Person", "Organization"], {
  method: "hybrid",
  options: {
    hybrid: { query: "AI", alpha: 0.5 },
    limit: 5,
  }
});

console.log("People:", results.Person.objects);
console.log("Organizations:", results.Organization.objects);
```

### Custom Plugin Registration

```typescript
// Register custom plugin
weaviate.registerPlugin(new MyCustomPlugin());

// Use in schema
const Person: SchemaConfig = {
  name: "Person",
  plugins: ["myCustomPlugin"],
  // ... rest of schema
};
```

---

**Next Steps**: For performance optimization tips, see the [Performance Guide](./PERFORMANCE.md).
