# Weaviate - Quick Start Guide

Get up and running with the Weaviate Vector Search Framework in minutes!

## 🚀 Basic Usage

```typescript
import Weaviate, { WeaviateConfigService, WeaviateError, WeaviateErrorCode } from "./lib/weaviate";
import { schemas } from "./config/schemas";

// 1. Initialize Weaviate client (once at app startup)
await WeaviateConfigService.initializeClient();

// 2. Create Weaviate instance
const weaviate = new Weaviate();

// 3. Initialize schemas (once at app startup)
await weaviate.initializeSchemas(schemas);

// 4. Search with the new discriminated union pattern
const people = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "software engineer", alpha: 0.5 },
    limit: 10
  }
});

// 5. Use convenience methods for simpler syntax
const results = await weaviate.hybridSearch("Person", "AI researcher");
```

## 🏗️ Constructor & Configuration

### Default Initialization

```typescript
// Auto-initializes with default plugins
const weaviate = new Weaviate();
```

### Custom Configuration

```typescript
import { WeaviateOptions } from "./lib/weaviate";

// With custom registry
const weaviate = new Weaviate({
  registry: myCustomRegistry
});

// With custom plugins
const weaviate = new Weaviate({
  plugins: [new MyCustomPlugin()]
});
```

## 🔍 Search Methods

### Type-Safe Search (Recommended)

The new discriminated union pattern provides compile-time type safety:

```typescript
// Vector search - TypeScript knows options must include nearText
const vectorResults = await weaviate.search("Person", {
  method: "vector",
  options: {
    nearText: { concepts: ["engineer"], certainty: 0.7 },
    limit: 10
  }
});

// BM25 search - TypeScript knows options must include bm25
const keywordResults = await weaviate.search("Person", {
  method: "bm25",
  options: {
    bm25: { query: "John Smith" },
    limit: 10
  }
});

// Hybrid search - TypeScript knows options must include hybrid
const hybridResults = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "AI expert", alpha: 0.5 },
    limit: 10
  }
});
```

### Convenience Methods (Simpler)

For common use cases, use convenience methods:

```typescript
// Vector search with concepts
await weaviate.vectorSearch("Person", ["machine learning expert"]);

// BM25 keyword search
await weaviate.textSearch("Person", "John Smith");

// Hybrid search
await weaviate.hybridSearch("Person", "AI researcher", { alpha: 0.5 });

// Smart search (auto-selects method)
await weaviate.smartSearch("Person", "software engineer");
```

## 🚨 Error Handling

All operations now throw structured `WeaviateError` instances:

```typescript
import { WeaviateError, WeaviateErrorCode } from "./lib/weaviate";

try {
  await weaviate.createObject({
    class: "Person",
    properties: { name: "John Doe", email: "john@example.com" }
  });
} catch (error) {
  if (error instanceof WeaviateError) {
    console.log(`Error Code: ${error.code}`);
    console.log(`Message: ${error.message}`);
    console.log(`Details:`, error.details);
    
    // Handle specific error types
    if (error.is(WeaviateErrorCode.OBJECT_CREATION_ERROR)) {
      // Retry logic
    }
  }
}
```

See [Error Handling Guide](./ERROR_HANDLING.md) for complete documentation.

## 🔧 Query Builder

Build complex queries with a fluent API:

```typescript
import { QueryPatterns } from "./lib/weaviate";

// Fluent query building
const query = weaviate
  .queryBuilder("Person")
  .limit(10)
  .whereField("city", "Equal", "San Francisco")
  .sort("createdAt", "desc");

const results = await weaviate.search(
  "Person",
  {
    method: "hybrid",
    options: query.buildHybridSearch("engineer", { alpha: 0.5 })
  }
);

// Pre-built patterns
const dateQuery = QueryPatterns.dateRange("createdAt", startDate, endDate);
const textQuery = QueryPatterns.textContains("headline", "senior");
const inQuery = QueryPatterns.inValues("city", ["SF", "NY", "LA"]);
```

## 🌐 Universal Search

Search across multiple schemas simultaneously:

```typescript
const allResults = await weaviate.searchAll(
  ["Person", "Organization", "Conversation"],
  {
    method: "hybrid",
    options: {
      hybrid: { query: "AI", alpha: 0.6 },
      limit: 5
    }
  }
);

// Returns: { Person: SearchResult, Organization: SearchResult, Conversation: SearchResult }
```

## 🏢 Multi-Tenancy

### Setup Multi-Tenant Schema

```typescript
const schema = {
  name: "UserDocuments",
  description: "User-specific documents",
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
  properties: [
    { name: "title", dataType: ["string"] },
    { name: "content", dataType: ["text"] }
  ]
};

await weaviate.initializeSchemas([schema]);
```

### Create and Manage Tenants

```typescript
// Create tenant (validates name automatically)
await weaviate.createTenant("UserDocuments", { 
  name: "acme-corp",  // Must be lowercase alphanumeric with hyphens
  activityStatus: "HOT"
});

// List tenants
const tenants = await weaviate.listTenants("UserDocuments");

// Get tenant stats
const stats = await weaviate.getTenantStats("UserDocuments");
```

### Tenant-Aware Search

```typescript
// Search within specific tenant
const results = await weaviate.searchWithTenant(
  "UserDocuments",
  {
    method: "hybrid",
    options: {
      hybrid: { query: "machine learning", alpha: 0.5 },
      limit: 10
    }
  },
  "acme-corp"
);

// Smart search with tenant
const smartResults = await weaviate.smartSearchWithTenant(
  "UserDocuments",
  "AI expert",
  "acme-corp"
);
```

See [Multi-Tenancy Guide](./MULTI_TENANCY.md) for comprehensive documentation.

## 📊 Search Method Comparison

| Method | Speed | Accuracy | Best For | Alpha Value |
|--------|-------|----------|----------|-------------|
| **Vector** | Medium | High (semantic) | Natural language queries | N/A |
| **BM25** | Fast | High (keyword) | Exact term matching | N/A |
| **Hybrid** | Medium | **Highest** | General purpose ✨ | 0.0 - 1.0 |

### Alpha Parameter (Hybrid Search)

- `0.0` = Pure BM25 (keyword-only)
- `0.5` = Balanced (default, recommended)
- `1.0` = Pure vector (semantic-only)

## 🔌 Built-In Plugins

The plugin system allows you to enhance your data during operations. Custom plugins can be registered during initialization:

```typescript
// Register custom plugins
const weaviate = new Weaviate({
  plugins: [new MyCustomPlugin()]
});
```

See [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md) for creating custom plugins.

## 💾 CRUD Operations

```typescript
// Create object
const id = await weaviate.createObject({
  class: "Person",
  properties: {
    fullName: "John Doe",
    email: "john@example.com"
  }
});

// Create batch
const ids = await weaviate.createObjectsBatch([
  { class: "Person", properties: { fullName: "Alice" } },
  { class: "Person", properties: { fullName: "Bob" } }
]);

// Get object
const person = await weaviate.getObject("Person", id);

// Update object
await weaviate.updateObject("Person", id, {
  email: "newemail@example.com"
});

// Delete object
await weaviate.deleteObject("Person", id);
```

## 🧪 Testing Your Integration

```typescript
import { describe, it, expect } from "vitest";

describe("Weaviate Integration", () => {
  it("should search for people", async () => {
    const results = await weaviate.search("Person", {
      method: "hybrid",
      options: {
        hybrid: { query: "engineer" },
        limit: 10
      }
    });
    
    expect(results.objects).toBeDefined();
    expect(results.total).toBeGreaterThan(0);
  });
  
  it("should handle errors", async () => {
    await expect(
      weaviate.search("NonExistent", {
        method: "vector",
        options: { nearText: { concepts: ["test"] } }
      })
    ).rejects.toThrow(WeaviateError);
  });
});
```

## 📈 Performance Tips

1. **Use Hybrid Search** for best overall results
2. **Batch Operations** when creating multiple objects
3. **Limit Results** to what you actually need
4. **Index Strategically** - not all fields need to be searchable
5. **Use Multi-Tenancy** for natural data isolation
6. **Implement Error Handling** for resilient applications

## ✅ Common Patterns

### Pattern 1: Initialize Once

```typescript
// In your app initialization file
let weaviate: Weaviate;

export async function initializeWeaviate() {
  await WeaviateConfigService.initializeClient();
  weaviate = new Weaviate();
  await weaviate.initializeSchemas(schemas);
  return weaviate;
}

export function getWeaviate() {
  if (!weaviate) {
    throw new Error("Weaviate not initialized");
  }
  return weaviate;
}
```

### Pattern 2: Error Handling Wrapper

```typescript
async function safeSearch<T>(params: SearchParams): Promise<SearchResult<T> | null> {
  try {
    return await weaviate.search(params.schema, params.request);
  } catch (error) {
    if (error instanceof WeaviateError) {
      logger.error(`Search failed: ${error.code}`, error.details);
    }
    return null;
  }
}
```

### Pattern 3: Tenant-Scoped Service

```typescript
class TenantService {
  constructor(
    private weaviate: Weaviate,
    private tenantId: string
  ) {}
  
  async search(schema: string, query: string) {
    return this.weaviate.searchWithTenant(
      schema,
      {
        method: "hybrid",
        options: { hybrid: { query }, limit: 10 }
      },
      this.tenantId
    );
  }
}
```

## 📚 Next Steps

1. **Explore Examples**: See [Weaviate.example.ts](../Weaviate.example.ts) for comprehensive examples
2. **Read API Reference**: Check [API_REFERENCE.md](./API_REFERENCE.md) for all methods
3. **Schema Guide**: Learn schema patterns in [SCHEMA_GUIDE.md](./SCHEMA_GUIDE.md)
4. **Error Handling**: Master errors in [ERROR_HANDLING.md](./ERROR_HANDLING.md)
5. **Performance**: Optimize with [PERFORMANCE.md](./PERFORMANCE.md)

## 🆘 Troubleshooting

### "Schema not found in registry"
```typescript
// Make sure schema is initialized before searching
await weaviate.initializeSchemas([yourSchema]);
```

### "Invalid tenant name"
```typescript
// Tenant names must be lowercase alphanumeric with hyphens
// ✅ Good: "acme-corp", "tenant-123"
// ❌ Bad: "Acme Corp", "tenant_123"
```

### TypeScript errors with search
```typescript
// Make sure method and options match
// ✅ Correct:
{ method: "hybrid", options: { hybrid: { query: "test" } } }

// ❌ Incorrect:
{ method: "hybrid", options: { nearText: { concepts: ["test"] } } }
```

---

**Ready to get started?** Copy the basic usage example and start searching! 🚀

For more advanced usage, check out the [complete documentation](./README.md).
