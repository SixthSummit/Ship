# Weaviate Multi-Tenancy Support

This document describes the multi-tenancy features added to the Weaviate library, enabling tenant isolation and management for multi-tenant applications.

## Overview

Multi-tenancy in Weaviate allows you to:

- Isolate data between different tenants
- Manage tenant lifecycle (create, update, delete)
- Control tenant activity status (HOT, WARM, COLD)
- Perform tenant-aware searches and operations
- Automatically create and activate tenants

## Features

### 1. Multi-Tenant Schema Configuration

Enable multi-tenancy when creating schemas:

```typescript
import { SchemaConfig } from "./types/index.js";

const schema: SchemaConfig = {
  name: "UserDocuments",
  description: "User documents with multi-tenancy",
  vectorizer: "text2vec-openai",
  properties: [
    {
      name: "title",
      dataType: "text",
      indexInverted: true,
      indexFilterable: true,
      indexSearchable: true,
    },
    {
      name: "content",
      dataType: "text",
      indexInverted: true,
      indexFilterable: false,
      indexSearchable: true,
    },
  ],
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
};
```

### 2. Tenant Management

#### Create Tenants

```typescript
import Weaviate from "./Weaviate.js";

const weaviate = new Weaviate();

// Create a new tenant
const result = await weaviate.createTenant("UserDocuments", {
  name: "acme-corp",
  activityStatus: "HOT",
});

if (result.success) {
  console.log("Tenant created:", result.tenant);
}
```

#### List Tenants

```typescript
// List all tenants for a collection
const tenants = await weaviate.listTenants("UserDocuments");
console.log("Available tenants:", tenants);
```

#### Update Tenant Status

```typescript
// Update tenant activity status
const result = await weaviate.updateTenant("UserDocuments", "acme-corp", {
  activityStatus: "COLD", // Move to cold storage
});
```

#### Delete Tenants

```typescript
// Delete a tenant
const result = await weaviate.deleteTenant("UserDocuments", "acme-corp");
```

#### Get Tenant Statistics

```typescript
// Get tenant statistics
const stats = await weaviate.getTenantStats("UserDocuments");
console.log("Tenant stats:", stats);
// Output: { totalTenants: 5, activeTenants: 3, inactiveTenants: 1, coldTenants: 1 }
```

### 3. Tenant-Aware Operations

#### Search with Tenant Context

```typescript
// Method 1: Direct tenant specification
const results = await weaviate.searchWithTenant(
  "UserDocuments",
  "hybrid",
  {
    query: "machine learning",
    limit: 10,
  },
  "acme-corp",
);

// Method 2: Using tenant context manager
import TenantContextManager from "./utils/TenantContextManager.js";

await TenantContextManager.withContext("acme-corp", "HOT", async () => {
  const results = await weaviate.smartSearch("UserDocuments", "artificial intelligence", {
    limit: 5,
  });
  // Search automatically uses the tenant context
});
```

#### Create Objects in Specific Tenants

```typescript
// Create objects in a specific tenant
await TenantContextManager.withContext("acme-corp", "HOT", async () => {
  const objectId = await weaviate.getService().createObject({
    class: "UserDocuments",
    properties: {
      title: "AI in Healthcare",
      content: "Artificial intelligence is revolutionizing healthcare...",
    },
  });
});
```

### 4. Configuration

#### Environment Variables

```bash
# Enable multi-tenancy
WEAVIATE_MULTI_TENANCY_ENABLED=true

# Auto-create tenants when objects are inserted
WEAVIATE_AUTO_TENANT_CREATION=true

# Auto-activate inactive tenants
WEAVIATE_AUTO_TENANT_ACTIVATION=true
```

#### Weaviate Configuration

```typescript
import { WeaviateConfigService } from "./WeaviateConfig.js";

await WeaviateConfigService.initializeClient({
  host: "localhost",
  port: 8080,
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
});
```

## API Reference

### Types

#### MultiTenancyConfig

```typescript
interface MultiTenancyConfig {
  enabled: boolean;
  autoTenantCreation?: boolean;
  autoTenantActivation?: boolean;
}
```

#### Tenant

```typescript
interface Tenant {
  name: string;
  status: "ACTIVE" | "INACTIVE" | "COLD";
  activityStatus?: "HOT" | "WARM" | "COLD";
  createdAt?: string;
  updatedAt?: string;
}
```

#### TenantContext

```typescript
interface TenantContext {
  tenant: string;
  activityStatus?: "HOT" | "WARM" | "COLD";
}
```

### Methods

#### Weaviate Class Methods

- `createTenant(className: string, options: CreateTenantOptions): Promise<TenantManagementResult>`
- `listTenants(className: string): Promise<Tenant[]>`
- `getTenant(className: string, tenantName: string): Promise<Tenant | null>`
- `updateTenant(className: string, tenantName: string, options: UpdateTenantOptions): Promise<TenantManagementResult>`
- `deleteTenant(className: string, tenantName: string): Promise<TenantManagementResult>`
- `getTenantStats(className: string): Promise<TenantStats>`
- `isMultiTenant(className: string): Promise<boolean>`
- `searchWithTenant<T>(schemaName: string, method: string, options: any, tenant: string): Promise<SearchResult<T>>`
- `smartSearchWithTenant<T>(schemaName: string, query: string, tenant: string, options?: any): Promise<SearchResult<T>>`

#### TenantContextManager Methods

- `setContext(tenant: string, activityStatus?: string): void`
- `getContext(): TenantContext | null`
- `clearContext(): void`
- `hasContext(): boolean`
- `getCurrentTenant(): string | null`
- `withContext<T>(tenant: string, activityStatus: string, fn: () => Promise<T>): Promise<T>`
- `validateTenantName(tenant: string): boolean`
- `sanitizeTenantName(tenant: string): string`

#### TenantMiddleware Methods

- `fromHeader(headerName: string): Middleware`
- `fromParam(paramName: string): Middleware`
- `fromJWT(claimPath: string): Middleware`
- `fromBody(fieldName: string): Middleware`
- `require(): Middleware`
- `clear(): Middleware`

## Best Practices

### 1. Tenant Naming

- Use lowercase letters, numbers, and hyphens only
- Keep tenant names under 63 characters
- Use meaningful names (e.g., "acme-corp", "beta-llc")

### 2. Activity Status Management

- **HOT**: Frequently accessed tenants (default)
- **WARM**: Occasionally accessed tenants
- **COLD**: Rarely accessed tenants (cost optimization)

### 3. Error Handling

```typescript
try {
  const result = await weaviate.createTenant("UserDocuments", {
    name: "new-tenant",
    activityStatus: "HOT",
  });

  if (!result.success) {
    console.error("Failed to create tenant:", result.error);
  }
} catch (error) {
  console.error("Unexpected error:", error);
}
```

### 4. Performance Optimization

- Use appropriate activity status for tenants
- Monitor tenant statistics regularly
- Consider tenant lifecycle management
- Use batch operations when possible

## Migration Guide

### From Single-Tenant to Multi-Tenant

1. **Create new multi-tenant schema**:

   ```typescript
   const multiTenantSchema = {
     ...existingSchema,
     multiTenancy: { enabled: true },
   };
   ```

2. **Migrate data by tenant**:

   ```typescript
   // Create tenants first
   await weaviate.createTenant("NewSchema", { name: "tenant1" });

   // Migrate data with tenant context
   await TenantContextManager.withContext("tenant1", "HOT", async () => {
     // Migrate data for tenant1
   });
   ```

3. **Update application code**:
   - Add tenant context to all operations
   - Use tenant-aware search methods
   - Implement tenant middleware

## Troubleshooting

### Common Issues

1. **Tenant not found**: Ensure tenant exists before operations
2. **Invalid tenant name**: Use only lowercase letters, numbers, and hyphens
3. **Multi-tenancy not enabled**: Check schema configuration
4. **Permission errors**: Verify tenant access rights

### Debugging

```typescript
// Check if collection supports multi-tenancy
const isMultiTenant = await weaviate.isMultiTenant("UserDocuments");
console.log("Multi-tenancy enabled:", isMultiTenant);

// Get tenant statistics
const stats = await weaviate.getTenantStats("UserDocuments");
console.log("Tenant stats:", stats);

// List all tenants
const tenants = await weaviate.listTenants("UserDocuments");
console.log("Available tenants:", tenants);
```

## Examples

See `examples/MultiTenancyExample.ts` for comprehensive usage examples including:

- Schema creation with multi-tenancy
- Tenant management operations
- Tenant-aware searches
- Express middleware integration
- Configuration examples
