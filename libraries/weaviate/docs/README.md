# Weaviate Documentation Hub

Welcome to the comprehensive documentation for the Weaviate Vector Search Framework!

## 📚 Documentation Structure

### 🚀 Getting Started

Perfect for newcomers to the framework:

1. **[Quick Start Guide](./QUICK_START.md)** - Get up and running in 5 minutes
2. **[Configuration Guide](./CONFIGURATION.md)** - Environment setup and initialization
3. **[Complete Framework Guide](./WEAVIATE_README.md)** - In-depth framework documentation

### 📖 Core Documentation

Essential references for daily use:

- **[API Reference](./API_REFERENCE.md)** - Complete method documentation with examples
- **[Schema Guide](./SCHEMA_GUIDE.md)** - Creating and managing schemas
- **[Multi-Tenancy Guide](./MULTI_TENANCY.md)** - Tenant isolation and management
- **[Plugin Development](./PLUGIN_DEVELOPMENT.md)** - Creating custom plugins
- **[Performance Guide](./PERFORMANCE.md)** - Optimization tips and best practices

### 🔧 Technical Guides

Advanced topics and patterns:

- **[Error Handling](./ERROR_HANDLING.md)** - Comprehensive error handling with `WeaviateError`
- **[Working Examples](../Weaviate.example.ts)** - Comprehensive code examples

## 🎯 Quick Navigation

### For First-Time Users

1. Start with this **README** for an overview
2. Follow **[Quick Start](./QUICK_START.md)** to build your first integration
3. Review **[Working Examples](../Weaviate.example.ts)** for common patterns
4. Check **[API Reference](./API_REFERENCE.md)** when you need specific methods

### For Experienced Users

1. **[API Reference](./API_REFERENCE.md)** - Quick method lookup
2. **[Schema Guide](./SCHEMA_GUIDE.md)** - Advanced schema patterns
3. **[Plugin Development](./PLUGIN_DEVELOPMENT.md)** - Extending functionality
4. **[Performance Guide](./PERFORMANCE.md)** - Optimization techniques

### For Technical Leads

1. **[Complete Framework Guide](./WEAVIATE_README.md)** - Full feature documentation
2. **[Performance Guide](./PERFORMANCE.md)** - Optimization strategies
3. **[Error Handling](./ERROR_HANDLING.md)** - Error handling patterns

## 🔍 Search This Documentation

### By Topic

**Search Operations**
- [API Reference - Search Methods](./API_REFERENCE.md#search-methods)
- [Quick Start - Basic Search](./QUICK_START.md)
- [Performance - Search Optimization](./PERFORMANCE.md)

**Schema Management**
- [Schema Guide](./SCHEMA_GUIDE.md)
- [API Reference - Schema Operations](./API_REFERENCE.md#schema-operations)

**Error Handling**
- [Error Handling Guide](./ERROR_HANDLING.md)
- [API Reference - WeaviateError](./API_REFERENCE.md)

**Multi-Tenancy**
- [Multi-Tenancy Guide](./MULTI_TENANCY.md)
- [API Reference - Tenant Methods](./API_REFERENCE.md#multi-tenancy)

**Plugins**
- [Plugin Development](./PLUGIN_DEVELOPMENT.md)
- [Built-in Plugins](./WEAVIATE_README.md#plugins)

## 📦 Framework Components

### Core Classes

- **`Weaviate`** - Main framework class ([API Reference](./API_REFERENCE.md))
- **`WeaviateConfigService`** - Connection management ([Configuration](./CONFIGURATION.md))
- **`SchemaRegistry`** - Schema management ([Schema Guide](./SCHEMA_GUIDE.md))
- **`QueryBuilder`** - Fluent query API ([API Reference](./API_REFERENCE.md#query-builder))

### Error Handling

- **`WeaviateError`** - Structured error class ([Error Handling](./ERROR_HANDLING.md))
- **`WeaviateErrorCode`** - Error code enum ([Error Handling](./ERROR_HANDLING.md))

### Types

- **`SearchRequest`** - Discriminated union for search ([API Reference](./API_REFERENCE.md))
- **`SchemaConfig`** - Schema configuration ([Schema Guide](./SCHEMA_GUIDE.md))
- **`Plugin`** - Plugin interface ([Plugin Development](./PLUGIN_DEVELOPMENT.md))

### Utilities

- **`TenantContextManager`** - Tenant validation ([Multi-Tenancy](./MULTI_TENANCY.md))
- **`QueryPatterns`** - Common query patterns ([API Reference](./API_REFERENCE.md#query-patterns))

## 🎨 Common Use Cases

### 1. Basic Search

```typescript
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer" },
    limit: 10
  }
});
```

📖 See: [Quick Start](./QUICK_START.md), [API Reference - Search](./API_REFERENCE.md#search-methods)

### 2. Multi-Tenant Search

```typescript
const results = await weaviate.searchWithTenant("Person", {
  method: "hybrid",
  options: { hybrid: { query: "engineer" } }
}, "tenant-123");
```

📖 See: [Multi-Tenancy Guide](./MULTI_TENANCY.md)

### 3. Custom Schema

```typescript
const schema: SchemaConfig = {
  name: "Product",
  description: "Product catalog",
  properties: [
    { name: "name", dataType: ["string"] },
    { name: "price", dataType: ["number"] }
  ]
};
```

📖 See: [Schema Guide](./SCHEMA_GUIDE.md)

### 4. Error Handling

```typescript
try {
  await weaviate.createObject({ ... });
} catch (error) {
  if (error instanceof WeaviateError) {
    console.log(`Error ${error.code}: ${error.message}`);
  }
}
```

📖 See: [Error Handling](./ERROR_HANDLING.md)

### 5. Custom Plugin

```typescript
class MyPlugin implements Plugin {
  name = "my-plugin";
  version = "1.0.0";
  hooks = {
    beforeSearch: (schema, options) => {
      // Custom logic
      return options;
    }
  };
}
```

📖 See: [Plugin Development](./PLUGIN_DEVELOPMENT.md)

## 🚨 Error Codes Reference

Quick reference for common error codes:

| Code | Description | Guide |
|------|-------------|-------|
| `SEARCH_ERROR` | Search operation failed | [Error Handling](./ERROR_HANDLING.md) |
| `OBJECT_CREATION_ERROR` | Failed to create object | [Error Handling](./ERROR_HANDLING.md) |
| `SCHEMA_VALIDATION_ERROR` | Schema validation failed | [Schema Guide](./SCHEMA_GUIDE.md) |
| `TENANT_VALIDATION_ERROR` | Invalid tenant name | [Multi-Tenancy](./MULTI_TENANCY.md) |

See complete list in [Error Handling Guide](./ERROR_HANDLING.md#error-codes).

## 📊 Performance Comparison

| Method | Speed | Accuracy | Best For |
|--------|-------|----------|----------|
| Vector | Medium | High (semantic) | Natural language |
| BM25 | Fast | High (keyword) | Exact matches |
| Hybrid | Medium | **Highest** | General purpose ✨ |

📖 See: [Performance Guide](./PERFORMANCE.md)

## 🧪 Testing

```bash
# Run all tests
npm test

# Run Weaviate tests only
npm test -- src/lib/weaviate/

# Run with coverage
npm test -- --coverage
```

Current test coverage: **Comprehensive test suite** ✅

## 🔄 Recent Updates

### Version 2.0.0 - Major Improvements

- ✅ Discriminated union search API
- ✅ Structured error handling with `WeaviateError`
- ✅ Configurable plugin initialization
- ✅ Fail-fast schema validation
- ✅ Tenant name validation
- ✅ Simplified architecture
- ✅ Pure instance-based registry pattern
- ✅ Removed unused default plugins

## 🤝 Contributing

When contributing to the framework:

1. Follow established patterns and conventions
2. Add comprehensive tests for new functionality
3. Update relevant documentation
4. Use structured error handling with proper error codes
5. Ensure all tests pass before submitting

## 💡 Tips and Best Practices

1. **Use hybrid search** for general-purpose queries (best accuracy)
2. **Implement error handling** for all async operations
3. **Validate schemas** at registration time (fail-fast)
4. **Use plugins** to extend functionality without modifying core
5. **Enable multi-tenancy** for data isolation requirements
6. **Batch operations** when creating multiple objects
7. **Check error codes** for programmatic error handling

## 🔗 External Resources

- [Weaviate Official Documentation](https://weaviate.io/developers/weaviate)
- [Vector Search Concepts](https://weaviate.io/developers/weaviate/concepts)
- [BM25 Algorithm](https://en.wikipedia.org/wiki/Okapi_BM25)

## 📞 Support

- **Bug Reports**: Check documentation for known patterns
- **Feature Requests**: Review existing patterns in documentation
- **Questions**: Start with [Quick Start Guide](./QUICK_START.md)
- **Examples**: See [Weaviate.example.ts](../Weaviate.example.ts)

---

**Framework Version**: 2.0.0

**Documentation Last Updated**: 2025

**Status**: ✅ Production Ready

**Next Steps**: Start with [Quick Start Guide](./QUICK_START.md) →
