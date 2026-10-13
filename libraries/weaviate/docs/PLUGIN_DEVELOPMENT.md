# Plugin Development Guide

This guide covers how to create, test, and deploy custom plugins for the Weaviate framework.

## 🔌 Plugin System Overview

### What are Plugins?

Plugins are extensible components that enhance your data during the search and indexing process. They can:

- **Enrich Data**: Add computed fields, scores, or metadata
- **Transform Content**: Modify text before vectorization
- **Add Analytics**: Calculate metrics and insights
- **Integrate External APIs**: Fetch additional data
- **Custom Processing**: Apply business logic

### Built-in Plugins

The framework does not include default built-in plugins. You can create and register custom plugins as needed.

## 🏗️ Plugin Architecture

### Plugin Interface

```typescript
interface Plugin {
  name: string; // Plugin identifier
  version: string; // Plugin version
  description?: string; // Plugin description
  dependencies?: string[]; // Required dependencies
  initialize?(context: PluginContext): Promise<void>;
  process?(data: any, context: PluginContext): Promise<any>;
  cleanup?(): Promise<void>;
}
```

### Plugin Context

```typescript
interface PluginContext {
  schemaName: string; // Current schema being processed
  operation: "create" | "update" | "search" | "delete";
  metadata: Record<string, any>; // Additional context data
  logger: Logger; // Logging interface
}
```

## 🚀 Creating Your First Plugin

### Basic Plugin Structure

```typescript
// src/lib/weaviate/plugins/MyCustomPlugin.ts
import { Plugin, PluginContext } from "../types/Plugin.js";
import Logger from "@sixthsummit/ship-api/app/utils/Logger";

export default class MyCustomPlugin implements Plugin {
  name = "myCustomPlugin";
  version = "1.0.0";
  description = "My custom data enrichment plugin";

  async initialize(context: PluginContext): Promise<void> {
    Logger.log(`Initializing ${this.name} v${this.version}`);
    // Setup plugin resources
  }

  async process(data: any, context: PluginContext): Promise<any> {
    Logger.log(`Processing data for ${context.schemaName}`);

    // Your custom processing logic here
    const enrichedData = this.enrichData(data);

    return enrichedData;
  }

  async cleanup(): Promise<void> {
    Logger.log(`Cleaning up ${this.name}`);
    // Cleanup resources
  }

  private enrichData(data: any): any {
    // Add your custom enrichment logic
    return {
      ...data,
      enrichedAt: new Date().toISOString(),
      customField: "processed by MyCustomPlugin",
    };
  }
}
```

### Advanced Plugin with External API

```typescript
// src/lib/weaviate/plugins/ExternalDataPlugin.ts
import { Plugin, PluginContext } from "../types/Plugin.js";
import Logger from "@sixthsummit/ship-api/app/utils/Logger";

export default class ExternalDataPlugin implements Plugin {
  name = "externalDataPlugin";
  version = "1.0.0";
  description = "Enriches data with external API information";

  private apiKey: string;
  private baseUrl: string;

  async initialize(context: PluginContext): Promise<void> {
    this.apiKey = process.env.EXTERNAL_API_KEY || "";
    this.baseUrl = process.env.EXTERNAL_API_URL || "";

    if (!this.apiKey) {
      throw new Error("EXTERNAL_API_KEY environment variable is required");
    }

    Logger.log(`Initialized ${this.name} with API: ${this.baseUrl}`);
  }

  async process(data: any, context: PluginContext): Promise<any> {
    try {
      // Only process Person schemas
      if (context.schemaName !== "Person") {
        return data;
      }

      // Fetch external data
      const externalData = await this.fetchExternalData(data.email);

      // Merge with original data
      return {
        ...data,
        externalData: {
          company: externalData.company,
          industry: externalData.industry,
          location: externalData.location,
          lastUpdated: new Date().toISOString(),
        },
      };
    } catch (error) {
      Logger.log(`Error in ${this.name}:`, error);
      return data; // Return original data if processing fails
    }
  }

  private async fetchExternalData(email: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/enrich`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      throw new Error(`External API error: ${response.status}`);
    }

    return await response.json();
  }
}
```

## 🧪 Plugin Testing

### Unit Testing

```typescript
// src/lib/weaviate/plugins/MyCustomPlugin.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import MyCustomPlugin from "./MyCustomPlugin.js";

describe("MyCustomPlugin", () => {
  let plugin: MyCustomPlugin;
  let mockContext: PluginContext;

  beforeEach(() => {
    plugin = new MyCustomPlugin();
    mockContext = {
      schemaName: "Person",
      operation: "create",
      metadata: {},
      logger: {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    };
  });

  it("should initialize successfully", async () => {
    await expect(plugin.initialize(mockContext)).resolves.not.toThrow();
  });

  it("should process data correctly", async () => {
    const testData = { name: "John Doe", email: "john@example.com" };
    const result = await plugin.process(testData, mockContext);

    expect(result).toHaveProperty("enrichedAt");
    expect(result).toHaveProperty("customField");
    expect(result.customField).toBe("processed by MyCustomPlugin");
  });

  it("should handle errors gracefully", async () => {
    const invalidData = null;
    const result = await plugin.process(invalidData, mockContext);

    // Plugin should handle errors and return original data
    expect(result).toBe(invalidData);
  });
});
```

### Integration Testing

```typescript
// src/lib/weaviate/plugins/ExternalDataPlugin.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import ExternalDataPlugin from "./ExternalDataPlugin.js";

// Mock fetch
global.fetch = vi.fn();

describe("ExternalDataPlugin Integration", () => {
  let plugin: ExternalDataPlugin;
  let mockContext: PluginContext;

  beforeEach(() => {
    plugin = new ExternalDataPlugin();
    mockContext = {
      schemaName: "Person",
      operation: "create",
      metadata: {},
      logger: {
        log: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
    };

    // Set environment variables
    process.env.EXTERNAL_API_KEY = "test-key";
    process.env.EXTERNAL_API_URL = "https://api.example.com";
  });

  it("should fetch external data successfully", async () => {
    const mockResponse = {
      company: "Acme Corp",
      industry: "Technology",
      location: "San Francisco",
    };

    (fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const testData = { email: "john@example.com" };
    const result = await plugin.process(testData, mockContext);

    expect(result).toHaveProperty("externalData");
    expect(result.externalData.company).toBe("Acme Corp");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/enrich",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      }),
    );
  });
});
```

## 🔧 Plugin Registration

### Manual Registration

```typescript
// Register plugin with Weaviate instance
import MyCustomPlugin from "./plugins/MyCustomPlugin.js";

const weaviate = new Weaviate();
weaviate.registerPlugin(new MyCustomPlugin());
```

### Automatic Registration

```typescript
// In your schema configuration
const Person: SchemaConfig = {
  name: "Person",
  plugins: [
    "myCustomPlugin", // Your custom plugin
    "externalDataPlugin", // Another custom plugin
  ],
  // ... rest of schema
};
```

### Plugin Discovery

```typescript
// src/lib/weaviate/plugins/index.ts
export { default as MyCustomPlugin } from "./MyCustomPlugin.js";
export { default as ExternalDataPlugin } from "./ExternalDataPlugin.js";

// Plugin registry
export const PLUGIN_REGISTRY = {
  myCustomPlugin: MyCustomPlugin,
  externalDataPlugin: ExternalDataPlugin,
};
```

## 📊 Plugin Performance

### Caching

```typescript
export default class CachedDataPlugin implements Plugin {
  private cache = new Map<string, any>();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

  async process(data: any, context: PluginContext): Promise<any> {
    const cacheKey = this.generateCacheKey(data);
    const cached = this.cache.get(cacheKey);

    if (cached && this.isCacheValid(cached)) {
      return { ...data, ...cached.data };
    }

    const result = await this.fetchData(data);
    this.cache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    return { ...data, ...result };
  }

  private isCacheValid(cached: any): boolean {
    return Date.now() - cached.timestamp < this.cacheTimeout;
  }
}
```

### Batch Processing

```typescript
export default class BatchProcessingPlugin implements Plugin {
  private batch: any[] = [];
  private batchSize = 10;
  private batchTimeout = 1000; // 1 second

  async process(data: any, context: PluginContext): Promise<any> {
    this.batch.push({ data, context });

    if (this.batch.length >= this.batchSize) {
      return await this.processBatch();
    }

    // Set timeout for batch processing
    setTimeout(() => this.processBatch(), this.batchTimeout);

    return data; // Return original data immediately
  }

  private async processBatch(): Promise<void> {
    if (this.batch.length === 0) return;

    const batch = [...this.batch];
    this.batch = [];

    try {
      const results = await this.processBatchData(batch);
      // Apply results to original data
    } catch (error) {
      Logger.log("Batch processing error:", error);
    }
  }
}
```

## 🔍 Plugin Debugging

### Debug Logging

```typescript
export default class DebugPlugin implements Plugin {
  name = "debugPlugin";
  version = "1.0.0";

  async process(data: any, context: PluginContext): Promise<any> {
    Logger.log(`[${this.name}] Processing data:`, {
      schemaName: context.schemaName,
      operation: context.operation,
      dataKeys: Object.keys(data),
      timestamp: new Date().toISOString(),
    });

    const result = this.processData(data);

    Logger.log(`[${this.name}] Processing complete:`, {
      originalKeys: Object.keys(data),
      resultKeys: Object.keys(result),
      addedFields: Object.keys(result).filter((key) => !(key in data)),
    });

    return result;
  }
}
```

### Performance Monitoring

```typescript
export default class PerformancePlugin implements Plugin {
  name = "performancePlugin";
  version = "1.0.0";

  async process(data: any, context: PluginContext): Promise<any> {
    const startTime = performance.now();

    try {
      const result = await this.processData(data);
      const endTime = performance.now();

      Logger.log(`[${this.name}] Processing time: ${endTime - startTime}ms`);

      return result;
    } catch (error) {
      const endTime = performance.now();
      Logger.log(`[${this.name}] Error after ${endTime - startTime}ms:`, error);
      throw error;
    }
  }
}
```

## 🚀 Plugin Deployment

### Environment Configuration

```bash
# .env for plugin configuration
MY_PLUGIN_API_KEY=your-api-key
MY_PLUGIN_BASE_URL=https://api.example.com
MY_PLUGIN_CACHE_TTL=300000
MY_PLUGIN_BATCH_SIZE=10
```

### Plugin Configuration

```typescript
// src/lib/weaviate/plugins/ConfigurablePlugin.ts
export default class ConfigurablePlugin implements Plugin {
  name = "configurablePlugin";
  version = "1.0.0";

  private config: PluginConfig;

  async initialize(context: PluginContext): Promise<void> {
    this.config = {
      apiKey: process.env.MY_PLUGIN_API_KEY || "",
      baseUrl: process.env.MY_PLUGIN_BASE_URL || "",
      cacheTtl: parseInt(process.env.MY_PLUGIN_CACHE_TTL || "300000"),
      batchSize: parseInt(process.env.MY_PLUGIN_BATCH_SIZE || "10"),
    };
  }
}

interface PluginConfig {
  apiKey: string;
  baseUrl: string;
  cacheTtl: number;
  batchSize: number;
}
```

## 🔧 Best Practices

### 1. Error Handling

```typescript
async process(data: any, context: PluginContext): Promise<any> {
  try {
    return await this.processData(data);
  } catch (error) {
    Logger.log(`Plugin ${this.name} error:`, error);
    // Return original data instead of failing
    return data;
  }
}
```

### 2. Resource Management

```typescript
async cleanup(): Promise<void> {
  // Close connections, clear caches, etc.
  this.cache.clear();
  this.connection?.close();
}
```

### 3. Plugin Dependencies

```typescript
export default class DependentPlugin implements Plugin {
  name = "dependentPlugin";
  version = "1.0.0";
  dependencies = ["personEnrichment", "externalData"];

  async initialize(context: PluginContext): Promise<void> {
    // Check if dependencies are available
    const availablePlugins = context.metadata.availablePlugins || [];
    const missingDeps = this.dependencies.filter((dep) => !availablePlugins.includes(dep));

    if (missingDeps.length > 0) {
      throw new Error(`Missing dependencies: ${missingDeps.join(", ")}`);
    }
  }
}
```

### 4. Plugin Versioning

```typescript
export default class VersionedPlugin implements Plugin {
  name = "versionedPlugin";
  version = "2.1.0";

  async process(data: any, context: PluginContext): Promise<any> {
    // Check plugin version compatibility
    const requiredVersion = context.metadata.requiredVersion || "2.0.0";
    if (this.compareVersions(this.version, requiredVersion) < 0) {
      throw new Error(`Plugin version ${this.version} is too old`);
    }

    return this.processData(data);
  }
}
```

---

**Next Steps**: Once your plugins are developed, proceed to the [API Reference](./API_REFERENCE.md) to learn about all available methods and options.
