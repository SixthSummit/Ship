# Weaviate - Generalized Vector Search Framework

A comprehensive, schema-driven framework for Weaviate vector database operations with support for hybrid search, plugins, and extensible architecture.

## 🚀 Key Features

- **Schema-Driven**: Define schemas in configuration files, not hardcoded methods
- **Generic Operations**: Single methods work with any schema
- **Hybrid Search**: Vector + BM25 search with configurable alpha parameter
- **Query Builder**: Fluent API for complex queries
- **Plugin System**: Extensible with custom plugins for data enrichment
- **Smart Search**: Automatic method selection based on query characteristics
- **Universal Search**: Search across multiple schemas simultaneously
- **Multi-Tenancy**: Built-in tenant isolation and management
- **Tenant-Aware Operations**: All search methods support tenant context
- **Type Safety**: Full TypeScript support with proper interfaces

## 🏗️ Architecture

### Core Components

```
Weaviate Framework
├── Weaviate                 # Main class with all vector database operations
├── WeaviateConfig           # Configuration and connection management
├── SchemaRegistry           # Schema management and validation
├── QueryBuilder            # Fluent query building API
├── Plugin System           # Extensible plugin architecture
└── Schema Configurations   # Injected schema definitions
```

### Constructor & Initialization

```typescript
// Constructor - initializes from WeaviateConfigService
new Weaviate()                                                 // Simple constructor

// Initialize with schemas during app startup
await weaviate.initializeSchemas(schemas)                           // Initialize with schemas
```

### Schema Organization

Schemas are now organized in a clean separation between application configuration and framework code:

```
src/
├── config/schemas/           # Application-specific schemas
│   ├── Person.ts            # Individual schema files
│   ├── Organization.ts
│   ├── Account.ts
│   └── index.ts             # Schema exports
└── lib/weaviate/
    ├── schemas/             # Framework schema management
    │   ├── SchemaRegistry.ts
    │   └── index.ts         # Re-exports from config
    └── types/               # Framework types
```

### Schema Configuration

Schemas are defined in individual files with rich metadata:

```typescript
{
  name: "Person",
  description: "A person in the social graph",
  vectorizer: {
    name: "text2vec-cohere",
    model: "embed-multilingual-v3.0",
    dimensions: 1024,
  },
  properties: [
    {
      name: "fullName",
      dataType: ["string"],
      indexSearchable: true,
      weight: 2.0,
      boost: 1.5,
    },
    // ... more properties
  ],
  searchableFields: ["fullName", "headline", "bio"],
  filterableFields: ["city", "countryCode"],
  plugins: ["personEnrichment", "similarityBoost"],
}
```

## 📖 Usage

### Basic Initialization

```typescript
import Weaviate from "../Weaviate.js";
import { WeaviateConfigService } from "../WeaviateConfig.js";
import { schemas } from "../../../config/schemas/index.js";

// Initialize Weaviate client first
await WeaviateConfigService.initializeClient();

// Create Weaviate instance (handles everything internally!)
const weaviate = new Weaviate();

// Initialize schemas (only required during app startup)
await weaviate.initializeSchemas(schemas);
```

### Generic Search

```typescript
// Search any schema with discriminated union pattern
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: {
      query: "software engineer",
      alpha: 0.5,
    },
    limit: 10,
  }
});

// Smart search with automatic method selection
const smartResults = await weaviate.smartSearch("Person", "machine learning expert");
```

### Query Builder

```typescript
// Fluent query building
const query = weaviate
  .queryBuilder("Person")
  .limit(10)
  .whereField("city", "Equal", "San Francisco")
  .sort("createdAt", "desc")
  .includeVector();

// Build different search types
const vectorOptions = query.buildVectorSearch("engineer", { certainty: 0.8 });
const hybridOptions = query.buildHybridSearch("data scientist", { alpha: 0.6 });
```

### Query Patterns

```typescript
import { QueryPatterns } from "../QueryBuilder.js";

// Date range search
const dateQuery = QueryPatterns.dateRange("createdAt", startDate, endDate);

// Text contains search
const textQuery = QueryPatterns.textContains("headline", "senior");

// Multiple values search
const multiQuery = QueryPatterns.inValues("city", ["SF", "NYC", "Seattle"]);
```

### Universal Search

```typescript
// Search across multiple schemas
const allResults = await framework.searchAll(["Person", "Organization", "Conversation"], "hybrid", {
  hybrid: { query: "artificial intelligence", alpha: 0.6 },
  limit: 5,
});

console.log(`People: ${allResults.Person.objects.length}`);
console.log(`Organizations: ${allResults.Organization.objects.length}`);
console.log(`Conversations: ${allResults.Conversation.objects.length}`);
```

## 🏢 Multi-Tenancy

### Multi-Tenant Schema Configuration

```typescript
const UserDocuments: SchemaConfig = {
  name: "UserDocuments",
  description: "User documents with multi-tenancy",
  vectorizer: "text2vec-openai",
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
  properties: [
    {
      name: "title",
      type: "string",
      searchable: true,
      filterable: true,
    },
    {
      name: "content",
      type: "text",
      searchable: true,
      vectorizable: true,
    },
  ],
};
```

### Tenant Management

```typescript
// Create tenants for different organizations
await weaviate.createTenant("UserDocuments", { name: "acme-corp" });
await weaviate.createTenant("UserDocuments", { name: "beta-llc" });

// List all tenants
const tenants = await weaviate.listTenants("UserDocuments");

// Update tenant activity status
await weaviate.updateTenant("UserDocuments", "acme-corp", {
  activityStatus: "COLD", // Move to cold storage
});

// Get tenant statistics
const stats = await weaviate.getTenantStats("UserDocuments");
console.log(`Total tenants: ${stats.totalTenants}`);
```

### Tenant-Aware Operations

```typescript
// Search within a specific tenant
const results = await weaviate.searchWithTenant(
  "UserDocuments",
  "hybrid",
  {
    hybrid: { query: "machine learning", alpha: 0.5 },
  },
  "acme-corp",
);

// Smart search with tenant context
const smartResults = await weaviate.smartSearchWithTenant(
  "UserDocuments",
  "AI expert",
  "acme-corp",
);

// Using tenant context manager
import TenantContextManager from "./utils/TenantContextManager.js";

await TenantContextManager.withContext("acme-corp", "HOT", async () => {
  const results = await weaviate.smartSearch("UserDocuments", "search query");
  // All operations automatically use the tenant context
});
```

## 🔌 Plugin System

### Built-in Plugins

No default plugins are included. You can create and register custom plugins as needed.

### Custom Plugin Example

```typescript
class CustomEnrichmentPlugin implements Plugin {
  name = "customEnrichment";
  version = "1.0.0";
  description = "Custom data enrichment";

  hooks = {
    beforeSearch: (className, options) => {
      // Enhance search options
      return options;
    },
    afterSearch: (className, result) => {
      // Enhance search results
      return result;
    },
  };
}

// Register custom plugin
framework.registerPlugin(new CustomEnrichmentPlugin());
```

## 🎯 Search Methods

### Vector Search (Semantic)

- **Best for**: Natural language queries, concept-based search
- **Use cases**: "Find people interested in machine learning"
- **Strengths**: Understands context and meaning

### BM25 Search (Keyword)

- **Best for**: Exact keyword matching, specific terms
- **Use cases**: "Find people with 'Python' in their bio"
- **Strengths**: Fast, precise keyword matching

### Hybrid Search (Vector + BM25)

- **Best for**: Most use cases - combines both methods
- **Alpha parameter**:
  - `0.0` = Pure BM25 (keyword-only)
  - `0.5` = Balanced (default)
  - `1.0` = Pure vector (semantic-only)

## 📊 Performance Characteristics

| Method | Speed  | Accuracy        | Best For                 |
| ------ | ------ | --------------- | ------------------------ |
| Vector | Medium | High (semantic) | Natural language queries |
| BM25   | Fast   | High (keyword)  | Exact term matching      |
| Hybrid | Medium | **Highest**     | General purpose search   |

## 🔧 Advanced Features

### Schema Registry

```typescript
// Get schema information
const personInfo = framework.getSchemaInfo("Person");
console.log("Searchable fields:", personInfo.searchableFields);
console.log(
  "Plugins:",
  personInfo.plugins.map((p) => p.name),
);

// Get framework statistics
const stats = framework.getStats();
console.log("Total schemas:", stats.registry.totalSchemas);
console.log("Schemas by category:", stats.registry.schemasByCategory);
```

### Custom Schema Registration

```typescript
const customSchema = {
  name: "Product",
  description: "A product in the catalog",
  vectorizer: { name: "text2vec-cohere" },
  properties: [
    {
      name: "name",
      dataType: ["string"],
      indexSearchable: true,
      weight: 2.0,
    },
    // ... more properties
  ],
  searchableFields: ["name", "description"],
  filterableFields: ["category", "price"],
};

framework.registerSchema(customSchema);
```

### Health Monitoring

```typescript
// Health check
const isHealthy = await framework.healthCheck();
console.log(`Framework health: ${isHealthy ? "healthy" : "unhealthy"}`);

// Get service statistics
const stats = weaviate.getStats();
console.log("Service statistics:", stats);
```

## 🚀 Architecture Benefits

### Unified API

```typescript
// Simple, consistent interface for all schemas with discriminated union
const people = await weaviate.search("Person", {
  method: "hybrid",
  options: { hybrid: { query: "engineer", alpha: 0.5 } }
});
const orgs = await weaviate.search("Organization", {
  method: "hybrid",
  options: { hybrid: { query: "startup", alpha: 0.5 } }
});
const convs = await weaviate.search("Conversation", {
  method: "hybrid",
  options: { hybrid: { query: "AI", alpha: 0.5 } }
});

// Or use convenience methods
const people = await weaviate.hybridSearch("Person", "engineer");
const orgs = await weaviate.smartSearch("Organization", "startup");
```

## 📁 File Structure

```
src/
├── config/schemas/                # Application schemas
│   ├── Person.ts                 # Individual schema files
│   ├── Organization.ts
│   ├── Account.ts
│   ├── Conversation.ts
│   ├── Message.ts
│   └── index.ts                  # Schema exports
└── lib/weaviate/                 # Framework code
    ├── Weaviate.ts               # Main framework class with all operations
    ├── QueryBuilder.ts           # Fluent query builder
    ├── WeaviateConfig.ts         # Configuration and connection management
    ├── docs/                     # Documentation
    │   ├── README.md             # Overview
    │   ├── QUICK_START.md        # Quick start guide
    │   └── WEAVIATE_README.md    # Comprehensive docs
    ├── schemas/                  # Framework schema management
    │   ├── SchemaRegistry.ts     # Schema registry
    │   └── index.ts              # Re-exports from config
    ├── types/                    # TypeScript definitions
    │   ├── SchemaConfig.ts
    │   ├── SearchOptions.ts
    │   └── index.ts
    ├── plugins/                  # Plugin system
    │   └── index.ts              # Custom plugins can be added here
    └── Weaviate.example.ts       # Usage examples
```

## 🧪 Testing with Dependency Injection

The new constructor makes testing much easier with dependency injection:

```typescript
import { Weaviate } from "./Weaviate.js";
import { SchemaConfig } from "./types/index.js";

// Mock schemas for testing
const mockSchemas: Record<string, SchemaConfig> = {
  Person: {
    name: "Person",
    description: "Test person schema",
    vectorizer: { name: "text2vec-cohere", model: "embed-multilingual-v3.0", dimensions: 1024 },
    vectorIndexConfig: { distance: "cosine", ef: 64, efConstruction: 128, maxConnections: 16 },
    properties: [],
    searchableFields: [],
    filterableFields: [],
    sortableFields: [],
    plugins: [],
    metadata: { category: "entity", priority: "high", searchWeight: 1.0 },
  },
};

// Test with mock dependencies
// Mock WeaviateConfigService to return your mock client
vi.mock("./WeaviateConfig.js", () => ({
  WeaviateConfigService: {
    getClient: vi.fn().mockReturnValue(mockClient),
  },
}));

const weaviate = new Weaviate();
// Register test schemas
weaviate.registerSchema(mockSchemas.Person);
```

### Testing Benefits:

- **Simplified Mocking**: Mock just the WeaviateConfigService
- **Isolation**: Test with mock schemas and dependencies
- **Flexibility**: Use different schemas for different test scenarios
- **Reliability**: No external dependencies in tests
- **Speed**: Fast unit tests without database connections

## 🎨 Benefits of the New Framework

### 1. **Extensibility**

- Add new schemas without code changes
- Register custom plugins for any schema
- Extend functionality without modifying core code

### 2. **Maintainability**

- Schema definitions in external files
- Generic methods reduce code duplication
- Plugin system for modular functionality

### 3. **Flexibility**

- Query builder for complex queries
- Smart search with automatic method selection
- Universal search across multiple schemas

### 4. **Performance**

- Optimized search methods
- Plugin hooks for data enrichment
- Configurable search parameters

### 5. **Developer Experience**

- Fluent API for query building
- Type safety with TypeScript
- Comprehensive examples and documentation

## 🔮 Future Enhancements

- **GraphQL Integration**: Direct GraphQL query support
- **Real-time Updates**: WebSocket support for live data
- **Advanced Analytics**: Built-in analytics and insights
- **Multi-tenant Support**: Schema isolation for multiple tenants
- **Caching Layer**: Intelligent caching for improved performance
- **A/B Testing**: Built-in A/B testing for search algorithms

## 📚 Examples

See `../Weaviate.example.ts` for comprehensive usage examples including:

- Generic search patterns
- Smart search with automatic method selection
- Query builder usage
- Query patterns for common operations
- Universal search across multiple schemas
- Custom schema registration
- Plugin system usage
- Complete workflow examples

The Weaviate provides a powerful, flexible, and extensible foundation for vector search operations in your social-sweep API! 🚀
