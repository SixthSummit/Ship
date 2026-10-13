# Schema Guide

This guide covers how to create, manage, and optimize schemas for the Weaviate framework.

## 📋 Schema Basics

### What is a Schema?

A schema defines the structure of your data in Weaviate, including:

- **Properties**: Fields and their types
- **Vectorization**: How text is converted to vectors
- **Indexing**: How data is indexed for search
- **Relationships**: Connections between different data types

### Schema Structure

```typescript
interface SchemaConfig {
  name: string; // Schema name (e.g., "Person")
  description?: string; // Human-readable description
  vectorizer?: Vectorizer; // Vectorization configuration
  vectorIndexConfig?: VectorIndexConfig; // Index settings
  properties: SearchableField[]; // Data fields
  searchableFields?: string[]; // Fields to include in search
  filterableFields?: string[]; // Fields for filtering
  sortableFields?: string[]; // Fields for sorting
  relationships?: {
    // Schema relationships
    [fieldName: string]: {
      targetClass: string;
      type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
      required?: boolean;
    };
  };
  plugins?: string[]; // Custom plugins
  metadata?: Record<string, any>; // Additional metadata
  multiTenancy?: MultiTenancyConfig; // Multi-tenancy configuration
}
```

## 🏗️ Creating Schemas

### Basic Schema Example

```typescript
// src/config/schemas/Person.ts
import { SchemaConfig } from "../../lib/weaviate/types/index.js";

const Person: SchemaConfig = {
  name: "Person",
  description: "Individual person with profile information",
  properties: [
    {
      name: "firstName",
      type: "string",
      description: "Person's first name",
      searchable: true,
      filterable: true,
      sortable: true,
    },
    {
      name: "lastName",
      type: "string",
      description: "Person's last name",
      searchable: true,
      filterable: true,
      sortable: true,
    },
    {
      name: "email",
      type: "string",
      description: "Email address",
      searchable: true,
      filterable: true,
      unique: true,
    },
    {
      name: "bio",
      type: "text",
      description: "Personal biography",
      searchable: true,
      vectorizable: true,
    },
    {
      name: "skills",
      type: "string[]",
      description: "List of skills",
      searchable: true,
      filterable: true,
    },
    {
      name: "createdAt",
      type: "date",
      description: "Creation timestamp",
      filterable: true,
      sortable: true,
    },
  ],
  searchableFields: ["firstName", "lastName", "email", "bio", "skills"],
  filterableFields: ["firstName", "lastName", "email", "skills", "createdAt"],
  sortableFields: ["firstName", "lastName", "createdAt"],
};
```

### Advanced Schema with Relationships

```typescript
// src/config/schemas/Organization.ts
import { SchemaConfig } from "../../lib/weaviate/types/index.js";

const Organization: SchemaConfig = {
  name: "Organization",
  description: "Company or organization",
  properties: [
    {
      name: "name",
      type: "string",
      description: "Organization name",
      searchable: true,
      filterable: true,
      sortable: true,
    },
    {
      name: "description",
      type: "text",
      description: "Organization description",
      searchable: true,
      vectorizable: true,
    },
    {
      name: "industry",
      type: "string",
      description: "Industry sector",
      searchable: true,
      filterable: true,
    },
    {
      name: "size",
      type: "string",
      description: "Company size",
      filterable: true,
    },
    {
      name: "website",
      type: "string",
      description: "Company website",
      filterable: true,
    },
  ],
  relationships: {
    employees: {
      targetClass: "Person",
      type: "one-to-many",
      required: false,
    },
  },
  searchableFields: ["name", "description", "industry"],
  filterableFields: ["name", "industry", "size"],
  sortableFields: ["name", "size"],
};
```

### Multi-Tenant Schema Example

```typescript
// src/config/schemas/UserDocuments.ts
import { SchemaConfig } from "../../lib/weaviate/types/index.js";

const UserDocuments: SchemaConfig = {
  name: "UserDocuments",
  description: "User documents with multi-tenancy enabled",
  vectorizer: "text2vec-openai",
  properties: [
    {
      name: "title",
      type: "string",
      description: "Document title",
      searchable: true,
      filterable: true,
      sortable: true,
    },
    {
      name: "content",
      type: "text",
      description: "Document content",
      searchable: true,
      vectorizable: true,
    },
    {
      name: "category",
      type: "string",
      description: "Document category",
      searchable: true,
      filterable: true,
    },
    {
      name: "createdAt",
      type: "date",
      description: "Creation timestamp",
      filterable: true,
      sortable: true,
    },
  ],
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
  searchableFields: ["title", "content", "category"],
  filterableFields: ["title", "category", "createdAt"],
  sortableFields: ["title", "createdAt"],
};
```

## 🔧 Field Types

### Supported Field Types

| Type             | Description      | Searchable | Filterable | Vectorizable |
| ---------------- | ---------------- | ---------- | ---------- | ------------ |
| `string`         | Short text       | ✅         | ✅         | ❌           |
| `text`           | Long text        | ✅         | ❌         | ✅           |
| `string[]`       | Array of strings | ✅         | ✅         | ❌           |
| `int`            | Integer number   | ❌         | ✅         | ❌           |
| `float`          | Decimal number   | ❌         | ✅         | ❌           |
| `boolean`        | True/false       | ❌         | ✅         | ❌           |
| `date`           | Date/time        | ❌         | ✅         | ❌           |
| `geoCoordinates` | GPS coordinates  | ❌         | ✅         | ❌           |

### Field Configuration

```typescript
interface SearchableField {
  name: string; // Field name
  type: string; // Field type
  description?: string; // Human-readable description
  searchable?: boolean; // Include in search (default: false)
  filterable?: boolean; // Allow filtering (default: false)
  sortable?: boolean; // Allow sorting (default: false)
  vectorizable?: boolean; // Include in vectorization (default: false)
  unique?: boolean; // Enforce uniqueness (default: false)
  required?: boolean; // Required field (default: false)
  defaultValue?: any; // Default value
  validation?: {
    // Custom validation rules
    min?: number;
    max?: number;
    pattern?: string;
    enum?: string[];
  };
}
```

## 🎯 Vectorization

### Text Vectorization

```typescript
const Person: SchemaConfig = {
  name: "Person",
  vectorizer: {
    module: "text2vec-openai", // or text2vec-cohere, text2vec-huggingface
    config: {
      model: "text-embedding-ada-002",
      dimensions: 1536,
    },
  },
  properties: [
    {
      name: "bio",
      type: "text",
      vectorizable: true, // This field will be vectorized
    },
  ],
};
```

### Vector Index Configuration

```typescript
const Person: SchemaConfig = {
  name: "Person",
  vectorIndexConfig: {
    distance: "cosine", // cosine, dot, l2-squared
    efConstruction: 128, // Build-time parameter
    maxConnections: 16, // Maximum connections per node
    ef: 64, // Query-time parameter
  },
  // ... rest of schema
};
```

## 🔗 Relationships

### One-to-One Relationship

```typescript
const Person: SchemaConfig = {
  name: "Person",
  properties: [
    {
      name: "profile",
      type: "object",
      description: "Personal profile information",
    },
  ],
  relationships: {
    profile: {
      targetClass: "Profile",
      type: "one-to-one",
      required: false,
    },
  },
};
```

### One-to-Many Relationship

```typescript
const Organization: SchemaConfig = {
  name: "Organization",
  relationships: {
    employees: {
      targetClass: "Person",
      type: "one-to-many",
      required: false,
    },
  },
};
```

### Many-to-Many Relationship

```typescript
const Person: SchemaConfig = {
  name: "Person",
  relationships: {
    skills: {
      targetClass: "Skill",
      type: "many-to-many",
      required: false,
    },
  },
};
```

## 📁 Schema Organization

### File Structure

```
src/config/schemas/
├── index.ts              # Export all schemas
├── Person.ts             # Person schema
├── Organization.ts       # Organization schema
├── Conversation.ts       # Conversation schema
└── Message.ts           # Message schema
```

### Schema Index

```typescript
// src/config/schemas/index.ts
export { default as Person } from "./Person.js";
export { default as Organization } from "./Organization.js";
export { default as Conversation } from "./Conversation.js";
export { default as Message } from "./Message.js";

import Person from "./Person.js";
import Organization from "./Organization.js";
import Conversation from "./Conversation.js";
import Message from "./Message.js";

// Export schemas as an array for easier consumption
export const schemas = [Person, Organization, Conversation, Message];

export default schemas;
```

## 🏢 Multi-Tenancy Configuration

### Basic Multi-Tenant Schema

```typescript
const UserDocuments: SchemaConfig = {
  name: "UserDocuments",
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
  // ... rest of schema
};
```

### Multi-Tenancy Options

- **`enabled`**: Enable multi-tenancy for this schema
- **`autoTenantCreation`**: Automatically create tenants when objects are inserted
- **`autoTenantActivation`**: Automatically activate inactive tenants

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
```

## 🔌 Plugin Integration

### Built-in Plugins

```typescript
const Person: SchemaConfig = {
  name: "Person",
  plugins: [
    "personEnrichment", // Automatic profile analysis
    "conversationAnalysis", // Activity level analysis
  ],
  // ... rest of schema
};
```

### Custom Plugin Integration

```typescript
const CustomSchema: SchemaConfig = {
  name: "CustomData",
  plugins: [
    "customEnrichment", // Your custom plugin
    "dataValidation", // Another custom plugin
  ],
  // ... rest of schema
};
```

## 🚀 Schema Registration

### Automatic Registration

```typescript
// In your application bootstrap
import Weaviate from "./lib/weaviate/Weaviate.js";
import { schemas } from "./config/schemas/index.js";

const weaviate = new Weaviate();
await weaviate.initializeSchemas(schemas);
```

### Manual Registration

```typescript
// Register individual schemas
weaviate.registerSchema(customSchema);
```

## 📊 Schema Optimization

### Search Performance

```typescript
// Optimize for search performance
const Person: SchemaConfig = {
  name: "Person",
  searchableFields: [
    "firstName", // High-frequency searches
    "lastName", // High-frequency searches
    "email", // Unique identifier
    "bio", // Rich content for semantic search
  ],
  // ... rest of schema
};
```

### Filtering Performance

```typescript
// Optimize for filtering
const Person: SchemaConfig = {
  name: "Person",
  filterableFields: [
    "createdAt", // Date range filtering
    "skills", // Category filtering
    "location", // Geographic filtering
  ],
  // ... rest of schema
};
```

### Vectorization Strategy

```typescript
// Strategic vectorization
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
```

## 🧪 Schema Testing

### Validation

```typescript
// Test schema validation
import { SchemaRegistry } from "./lib/weaviate/schemas/SchemaRegistry.js";

const registry = new SchemaRegistry(schemas);
const isValid = registry.validateSchema(Person);
console.log("Schema valid:", isValid);
```

### Schema Information

```typescript
// Get schema information
const schemaInfo = weaviate.getSchemaInfo("Person");
console.log("Schema info:", schemaInfo);
```

## 🔧 Best Practices

### 1. Naming Conventions

```typescript
// Use PascalCase for schema names
const Person: SchemaConfig = { name: "Person" };
const Organization: SchemaConfig = { name: "Organization" };

// Use camelCase for field names
properties: [
  { name: "firstName", type: "string" },
  { name: "lastName", type: "string" },
  { name: "createdAt", type: "date" },
];
```

### 2. Field Selection

```typescript
// Only vectorize fields that benefit from semantic search
{
  name: "bio",
  type: "text",
  vectorizable: true,  // Rich semantic content
}

// Use exact matching for structured data
{
  name: "email",
  type: "string",
  vectorizable: false, // Exact matching better
}
```

### 3. Relationship Design

```typescript
// Design relationships for your use case
relationships: {
  // One-to-many: Organization has many employees
  employees: {
    targetClass: "Person",
    type: "one-to-many",
  },
  // Many-to-many: Person has many skills
  skills: {
    targetClass: "Skill",
    type: "many-to-many",
  }
}
```

### 4. Performance Considerations

```typescript
// Limit searchable fields to essential ones
searchableFields: [
  "firstName", // Essential for person search
  "lastName", // Essential for person search
  "bio", // Rich content for semantic search
  // Avoid: "createdAt", "id", etc.
];
```

---

**Next Steps**: Once your schemas are defined, proceed to the [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md) to learn how to create custom plugins.
