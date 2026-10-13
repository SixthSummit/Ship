# Performance Guide

This guide covers performance optimization, best practices, and monitoring for the Weaviate framework.

## 📊 Performance Metrics

### Search Method Performance

| Method | Speed  | Accuracy        | Memory Usage | Best For                 |
| ------ | ------ | --------------- | ------------ | ------------------------ |
| Vector | Medium | High (semantic) | High         | Natural language queries |
| BM25   | Fast   | High (keyword)  | Low          | Exact term matching      |
| Hybrid | Medium | **Highest**     | Medium       | General purpose search   |

### Performance Benchmarks

```typescript
// Typical performance characteristics
const benchmarks = {
  vector: {
    latency: "50-200ms",
    throughput: "100-500 queries/sec",
    memory: "High (vector storage)",
  },
  bm25: {
    latency: "10-50ms",
    throughput: "500-2000 queries/sec",
    memory: "Low (text index)",
  },
  hybrid: {
    latency: "60-250ms",
    throughput: "80-400 queries/sec",
    memory: "Medium (combined)",
  },
};
```

## 🚀 Optimization Strategies

### 1. Schema Optimization

#### Strategic Field Selection

```typescript
// ✅ Good: Only vectorize fields that benefit from semantic search
const Person: SchemaConfig = {
  name: "Person",
  properties: [
    {
      name: "bio",
      type: "text",
      vectorizable: true, // Rich semantic content
    },
    {
      name: "firstName",
      type: "string",
      vectorizable: false, // Exact matching better
    },
  ],
};

// ❌ Bad: Vectorizing everything
const BadPerson: SchemaConfig = {
  properties: [
    { name: "email", vectorizable: true }, // Unnecessary
    { name: "phone", vectorizable: true }, // Unnecessary
    { name: "id", vectorizable: true }, // Unnecessary
  ],
};
```

#### Searchable Fields Optimization

```typescript
// ✅ Good: Limit searchable fields to essential ones
const Person: SchemaConfig = {
  searchableFields: [
    "firstName", // Essential for person search
    "lastName", // Essential for person search
    "bio", // Rich content for semantic search
    // Avoid: "createdAt", "id", "internalId"
  ],
};

// ❌ Bad: Making everything searchable
const BadPerson: SchemaConfig = {
  searchableFields: [
    "firstName",
    "lastName",
    "email",
    "phone",
    "createdAt",
    "updatedAt",
    "id",
    "internalId",
  ],
};
```

### 2. Query Optimization

#### Limit and Pagination

```typescript
// ✅ Good: Use appropriate limits
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer" },
    limit: 10, // Reasonable limit
    offset: 0,
  }
});

// ❌ Bad: No limits or excessive limits
const badResults = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer" },
    // No limit = potentially thousands of results
  }
});
```

#### Efficient Filtering

```typescript
// ✅ Good: Use filters to reduce search space
const results = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer" },
    where: {
      path: ["city"],
      operator: "Equal",
      valueText: "San Francisco",
    },
    limit: 10,
  }
});

// ❌ Bad: Search everything then filter in application
const allResults = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer" },
    limit: 1000, // Too many results
  }
});
// Then filter in JavaScript (inefficient)
```

### 3. Vector Index Optimization

#### Vector Index Configuration

```typescript
const Person: SchemaConfig = {
  name: "Person",
  vectorIndexConfig: {
    distance: "cosine", // Best for text similarity
    efConstruction: 128, // Higher = better quality, slower build
    maxConnections: 16, // Higher = better quality, more memory
    ef: 64, // Higher = better quality, slower queries
  },
};
```

#### Performance Tuning

```typescript
// For high-performance scenarios
const HighPerfConfig = {
  distance: "cosine",
  efConstruction: 256, // Higher quality
  maxConnections: 32, // More connections
  ef: 128, // Better search quality
};

// For fast queries (lower quality)
const FastConfig = {
  distance: "cosine",
  efConstruction: 64, // Faster build
  maxConnections: 8, // Less memory
  ef: 32, // Faster queries
};
```

### 4. Caching Strategies

#### Application-Level Caching

```typescript
// Cache frequent queries
class CachedWeaviateService {
  private cache = new Map<string, any>();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

  async search(schemaName: string, method: string, options: any) {
    const cacheKey = this.generateCacheKey(schemaName, method, options);
    const cached = this.cache.get(cacheKey);

    if (cached && this.isCacheValid(cached)) {
      return cached.data;
    }

    const result = await this.weaviate.search(schemaName, method, options);
    this.cache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    return result;
  }
}
```

#### Redis Caching

```typescript
import Redis from "ioredis";

class RedisCachedWeaviateService {
  private redis = new Redis(process.env.REDIS_URL);

  async search(schemaName: string, method: string, options: any) {
    const cacheKey = `weaviate:${schemaName}:${method}:${JSON.stringify(options)}`;

    // Try cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Execute search
    const result = await this.weaviate.search(schemaName, method, options);

    // Cache result
    await this.redis.setex(cacheKey, 300, JSON.stringify(result)); // 5 min TTL

    return result;
  }
}
```

## 🔍 Monitoring and Profiling

### Performance Monitoring

```typescript
class PerformanceMonitor {
  private metrics = {
    searchCount: 0,
    totalLatency: 0,
    averageLatency: 0,
    errorCount: 0,
  };

  async monitorSearch<T>(
    schemaName: string,
    method: string,
    options: any,
    searchFn: () => Promise<T>,
  ): Promise<T> {
    const startTime = performance.now();

    try {
      const result = await searchFn();
      const endTime = performance.now();

      this.updateMetrics(endTime - startTime, false);
      return result;
    } catch (error) {
      this.updateMetrics(0, true);
      throw error;
    }
  }

  private updateMetrics(latency: number, isError: boolean) {
    this.metrics.searchCount++;
    this.metrics.totalLatency += latency;
    this.metrics.averageLatency = this.metrics.totalLatency / this.metrics.searchCount;

    if (isError) {
      this.metrics.errorCount++;
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }
}
```

### Query Performance Analysis

```typescript
class QueryAnalyzer {
  analyzeQuery(options: any): QueryAnalysis {
    const analysis = {
      complexity: "low",
      estimatedLatency: "fast",
      recommendations: [],
    };

    // Analyze limit
    if (!options.limit || options.limit > 100) {
      analysis.recommendations.push("Consider adding a limit (recommended: 10-50)");
    }

    // Analyze filters
    if (!options.where) {
      analysis.recommendations.push("Consider adding filters to reduce search space");
    }

    // Analyze search method
    if (options.hybrid?.alpha === 1.0) {
      analysis.recommendations.push("Pure vector search - consider hybrid for better results");
    }

    return analysis;
  }
}
```

## 🏗️ Architecture Optimization

### Connection Pooling

```typescript
// The framework automatically handles connection pooling
// No additional configuration needed for basic usage

// For high-load scenarios, consider:
class OptimizedWeaviateService {
  private connectionPool: WeaviateClient[] = [];
  private maxConnections = 10;

  async initializePool() {
    for (let i = 0; i < this.maxConnections; i++) {
      const client = await WeaviateConfigService.initializeClient();
      this.connectionPool.push(client);
    }
  }

  getConnection(): WeaviateClient {
    // Round-robin connection selection
    const index = Math.floor(Math.random() * this.connectionPool.length);
    return this.connectionPool[index];
  }
}
```

### Batch Processing

```typescript
class BatchProcessor {
  private batch: any[] = [];
  private batchSize = 10;
  private batchTimeout = 1000; // 1 second

  async addToBatch(data: any) {
    this.batch.push(data);

    if (this.batch.length >= this.batchSize) {
      return await this.processBatch();
    }

    // Set timeout for batch processing
    setTimeout(() => this.processBatch(), this.batchTimeout);
  }

  private async processBatch() {
    if (this.batch.length === 0) return;

    const batch = [...this.batch];
    this.batch = [];

    // Process batch efficiently
    await this.processBatchData(batch);
  }
}
```

## 📈 Performance Best Practices

### 1. Schema Design

```typescript
// ✅ Good schema design
const OptimizedPerson: SchemaConfig = {
  name: "Person",
  // Only essential fields are searchable
  searchableFields: ["firstName", "lastName", "bio"],
  // Strategic vectorization
  properties: [
    { name: "bio", type: "text", vectorizable: true },
    { name: "firstName", type: "string", vectorizable: false },
  ],
  // Efficient indexing
  vectorIndexConfig: {
    distance: "cosine",
    efConstruction: 128,
    maxConnections: 16,
    ef: 64,
  },
};
```

### 2. Query Patterns

```typescript
// ✅ Efficient query patterns
const efficientQueries = {
  // Use filters to reduce search space
  filteredSearch: {
    hybrid: { query: "engineer" },
    where: { path: ["city"], operator: "Equal", valueText: "SF" },
    limit: 10,
  },

  // Use appropriate limits
  limitedSearch: {
    hybrid: { query: "AI" },
    limit: 20, // Reasonable limit
  },

  // Use pagination for large result sets
  paginatedSearch: {
    hybrid: { query: "developer" },
    limit: 10,
    offset: 0,
  },
};
```

### 3. Caching Strategy

```typescript
// ✅ Multi-level caching
class OptimizedCaching {
  private l1Cache = new Map(); // In-memory cache
  private l2Cache: Redis; // Redis cache

  async search(query: string) {
    // L1 Cache (fastest)
    if (this.l1Cache.has(query)) {
      return this.l1Cache.get(query);
    }

    // L2 Cache (fast)
    const cached = await this.l2Cache.get(query);
    if (cached) {
      this.l1Cache.set(query, cached);
      return cached;
    }

    // Database (slowest)
    const result = await this.executeSearch(query);

    // Cache at both levels
    this.l1Cache.set(query, result);
    await this.l2Cache.setex(query, 300, result);

    return result;
  }
}
```

### 4. Error Handling

```typescript
// ✅ Robust error handling
class ResilientWeaviateService {
  async searchWithRetry(schemaName: string, method: string, options: any, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.weaviate.search(schemaName, method, options);
      } catch (error) {
        if (attempt === maxRetries) {
          throw error;
        }

        // Exponential backoff
        await this.sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
}
```

## 🚨 Performance Anti-Patterns

### ❌ Common Mistakes

```typescript
// ❌ Don't: Search without limits
const badSearch = await weaviate.search("Person", {
  method: "hybrid",
  options: {
    hybrid: { query: "engineer" },
    // No limit = potentially thousands of results
  }
});

// ❌ Don't: Vectorize everything
const badSchema = {
  properties: [
    { name: "id", vectorizable: true }, // Unnecessary
    { name: "email", vectorizable: true }, // Unnecessary
    { name: "phone", vectorizable: true }, // Unnecessary
  ],
};

// ❌ Don't: Search then filter in application
const badPattern = async () => {
  const allResults = await weaviate.search("Person", {
    method: "hybrid",
    options: {
      hybrid: { query: "engineer" },
      limit: 1000,
    }
  });

  // Filtering in JavaScript (inefficient)
  return allResults.objects.filter((person) => person.city === "SF");
};

// ❌ Don't: No caching for repeated queries
const badCaching = async (query: string) => {
  // Same query executed multiple times
  return await weaviate.search("Person", {
    method: "hybrid",
    options: { hybrid: { query } }
  });
};
```

## 📊 Performance Monitoring Dashboard

### Metrics to Track

```typescript
interface PerformanceMetrics {
  // Search metrics
  searchCount: number;
  averageLatency: number;
  p95Latency: number;
  p99Latency: number;

  // Error metrics
  errorRate: number;
  timeoutRate: number;

  // Resource metrics
  memoryUsage: number;
  cpuUsage: number;

  // Cache metrics
  cacheHitRate: number;
  cacheSize: number;
}
```

### Monitoring Implementation

```typescript
class PerformanceDashboard {
  private metrics: PerformanceMetrics = {
    searchCount: 0,
    averageLatency: 0,
    p95Latency: 0,
    p99Latency: 0,
    errorRate: 0,
    timeoutRate: 0,
    memoryUsage: 0,
    cpuUsage: 0,
    cacheHitRate: 0,
    cacheSize: 0,
  };

  updateMetrics(searchLatency: number, isError: boolean) {
    this.metrics.searchCount++;
    this.metrics.averageLatency = (this.metrics.averageLatency + searchLatency) / 2;

    if (isError) {
      this.metrics.errorRate =
        (this.metrics.errorRate * (this.metrics.searchCount - 1) + 1) / this.metrics.searchCount;
    }
  }

  getHealthStatus(): "healthy" | "degraded" | "unhealthy" {
    if (this.metrics.errorRate > 0.1) return "unhealthy";
    if (this.metrics.averageLatency > 1000) return "degraded";
    return "healthy";
  }
}
```

---

**Next Steps**: For complete API documentation, see the [API Reference](./API_REFERENCE.md).
