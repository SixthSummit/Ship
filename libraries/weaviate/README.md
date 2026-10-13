# `libraries/weaviate/` — Weaviate vector search

A schema-driven framework around the Weaviate vector database with hybrid search, plugins, structured error handling, and an extensible architecture.

> **Install via**: `ship-api add -l weaviate`. Pulls in `weaviate-client`. Configure your Weaviate connection via env vars (see [`docs/CONFIGURATION.md`](./docs/CONFIGURATION.md)).

## 🚀 Quick Start

```typescript
import Weaviate, { WeaviateConfigService } from "@sixthsummit/ship-api/libraries/weaviate";
import { schemas } from "./config/schemas";

// 1. Initialize Weaviate client
await WeaviateConfigService.initializeClient();

// 2. Create Weaviate instance (auto-initializes with default plugins)
const weaviate = new Weaviate();

// 3. Initialize schemas (once during app startup)
await weaviate.initializeSchemas(schemas);

// 4. Search with the new discriminated union pattern
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer", alpha: 0.5 },
    limit: 10,
  },
});

// 5. Multi-tenant search
const tenantResults = await weaviate.searchWithTenant(
  "Person",
  {
    method: "hybrid",
    options: {
      hybrid: { query: "engineer", alpha: 0.5 },
      limit: 10,
    },
  },
  "acme-corp",
);
```

## ✨ What's New

### Recent Improvements

- ✅ **Discriminated Union Search API** - Type-safe search requests
- ✅ **Structured Error Handling** - `WeaviateError` with error codes
- ✅ **Configurable Plugins** - Control plugin initialization via options
- ✅ **Fail-Fast Validation** - Schema validation at registration time
- ✅ **Tenant Name Validation** - Consistent validation with helpful error messages
- ✅ **Simplified Architecture** - Merged `WeaviateService` into `Weaviate`
- ✅ **Instance-Based Registry** - Pure instance pattern (no global state)

## 📚 Documentation

### Essential Guides

- 📖 **[Complete Documentation Hub](./docs/README.md)** - Central documentation index
- 🚀 **[Quick Start Guide](./docs/QUICK_START.md)** - Get up and running in minutes
- 📘 **[API Reference](./docs/API_REFERENCE.md)** - Complete method documentation
- 🏗️ **[Schema Guide](./docs/SCHEMA_GUIDE.md)** - Creating and managing schemas
- ⚙️ **[Configuration Guide](./docs/CONFIGURATION.md)** - Environment setup
- 🏢 **[Multi-Tenancy Guide](./docs/MULTI_TENANCY.md)** - Tenant isolation and management
- 🔌 **[Plugin Development](./docs/PLUGIN_DEVELOPMENT.md)** - Creating custom plugins
- ⚡ **[Performance Guide](./docs/PERFORMANCE.md)** - Optimization tips

### Technical Documentation

- 🚨 **[Error Handling](./docs/ERROR_HANDLING.md)** - Comprehensive error handling guide
- 🔧 **[Architecture Review](./docs/README.md)** - Design decisions and patterns
- 📝 **[Examples](./Weaviate.example.ts)** - Working code examples

## 🔑 Key Features

### Core Functionality

- **🎯 Schema-Driven** - Define schemas in configuration files
- **⚡ Generic Operations** - Single methods work with any schema
- **🔍 Hybrid Search** - Vector + BM25 search with configurable alpha
- **🏗️ Query Builder** - Fluent API for complex queries
- **🔌 Plugin System** - Extensible with custom plugins
- **🤖 Smart Search** - Automatic method selection
- **🌐 Universal Search** - Search across multiple schemas
- **🏢 Multi-Tenancy** - Built-in tenant isolation and management
- **🚨 Error Handling** - Structured errors with codes for programmatic handling

### Advanced Features

- **Type-Safe Search** - Discriminated unions for compile-time safety
- **Instance-Based Registry** - No global state, fully testable
- **Configurable Plugins** - Enable/disable default plugins or provide custom ones
- **Fail-Fast Validation** - Errors caught at registration, not runtime
- **Tenant Validation** - Automatic validation with helpful suggestions
- **Comprehensive Logging** - Contextual error messages for debugging

## 🎨 API Patterns

### Constructor Options

```typescript
// Default: Auto-initializes with default plugins
const weaviate = new Weaviate();

// Custom registry
const weaviate = new Weaviate({
  registry: myCustomRegistry,
});

// Custom plugins
const weaviate = new Weaviate({
  plugins: [new MyPlugin()],
});
```

### Search Methods

```typescript
// Type-safe discriminated union pattern
const results = await weaviate.search("Person", {
  method: "vector", // TypeScript narrows options based on method
  options: {
    nearText: { concepts: ["engineer"] },
    limit: 10,
  },
});

// Convenience methods (simpler API)
await weaviate.vectorSearch("Person", ["engineer"]);
await weaviate.textSearch("Person", "John Smith");
await weaviate.hybridSearch("Person", "AI researcher");
await weaviate.smartSearch("Person", "software engineer");
```

### Error Handling

```typescript
import { WeaviateError, WeaviateErrorCode } from "@sixthsummit/ship-api/libraries/weaviate";

try {
  await weaviate.createObject({ class: "Person", properties: { name: "John" } });
} catch (error) {
  if (error instanceof WeaviateError) {
    console.log(`Error ${error.code}: ${error.message}`);

    if (error.is(WeaviateErrorCode.OBJECT_CREATION_ERROR)) {
      // Handle creation errors specifically
    }
  }
}
```

## 🔍 Search Types

### Vector Search (Semantic)

Best for natural language queries where meaning matters more than exact matches.

```typescript
await weaviate.vectorSearch("Person", ["machine learning expert"]);
```

### BM25 Search (Keyword)

Best for exact term matching and proper names.

```typescript
await weaviate.textSearch("Person", "John Smith");
```

### Hybrid Search (Recommended)

Combines both approaches for best overall results.

```typescript
await weaviate.hybridSearch("Person", "AI researcher", { alpha: 0.5 });
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run Weaviate tests only
npm test -- src/lib/weaviate/

# Run specific test file
npm test -- src/lib/weaviate/Weaviate.test.ts
```

## 📦 Package Structure

```
src/lib/weaviate/
├── Weaviate.ts              # Main framework class
├── WeaviateConfig.ts        # Connection management
├── QueryBuilder.ts          # Fluent query API
├── SchemaRegistry.ts        # Schema management
├── errors/                  # Error classes and codes
│   ├── WeaviateError.ts
│   └── index.ts
├── schemas/                 # Schema system
│   ├── SchemaRegistry.ts
│   └── index.ts
├── plugins/                 # Plugin system
│   └── index.ts              # Custom plugins can be added
├── types/                   # TypeScript types
│   ├── SearchRequest.ts
│   ├── SchemaConfig.ts
│   └── ...
├── utils/                   # Utilities
│   └── TenantContextManager.ts
└── docs/                    # Documentation
    ├── README.md
    ├── API_REFERENCE.md
    ├── QUICK_START.md
    └── ...
```

## 🔧 Development

Built with TypeScript featuring:

- **Full Type Safety** - Discriminated unions and strict typing
- **Comprehensive Tests** - Full test coverage across all components
- **Plugin Architecture** - Extensible design for custom functionality
- **Schema Validation** - Fail-fast validation at registration time
- **Error Handling** - Structured errors with codes
- **Performance Optimizations** - Efficient batch operations and caching

## 📝 Examples

See [Weaviate.example.ts](./Weaviate.example.ts) for comprehensive examples including:

- Schema initialization
- All search methods
- Query builder usage
- Query patterns
- Universal search
- Custom schema registration
- CRUD operations
- Multi-tenancy

## 🤝 Contributing

When making changes:

1. Follow the established patterns
2. Add tests for new functionality
3. Update documentation
4. Run tests before committing
5. Use structured error handling with `WeaviateError`

## 📊 Performance Tips

1. Use **hybrid search** for general-purpose queries
2. Use **vector search** for semantic/conceptual queries
3. Use **BM25 search** for exact names and keywords
4. Batch operations when creating multiple objects
5. Use multi-tenancy for data isolation
6. Implement proper error handling for resilience

## 🆘 Support

- **Documentation**: Start with [docs/README.md](./docs/README.md)
- **Examples**: See [Weaviate.example.ts](./Weaviate.example.ts)
- **API Reference**: Check [docs/API_REFERENCE.md](./docs/API_REFERENCE.md)
- **Error Handling**: Review [docs/ERROR_HANDLING.md](./docs/ERROR_HANDLING.md)
- **Architecture**: Review [docs/ARCHITECTURE_REVIEW.md](./docs/README.md) for design patterns

## 📄 License

Part of the SocialSweep API project.

---

**Version**: 2.0.0 (Major refactoring with discriminated unions and structured errors)

**Last Updated**: 2025

**Status**: ✅ Production Ready
