# Configuration Guide

This guide covers how to configure the Weaviate framework for your application.

## 🔧 Environment Variables

### Required Configuration

```bash
# Weaviate Connection
WEAVIATE_HOST=weaviate          # Docker service name or localhost
WEAVIATE_PORT=8080              # Weaviate port
WEAVIATE_SCHEME=http            # http or https
```

### Optional Configuration

```bash
# Authentication (if required)
WEAVIATE_API_KEY=your-api-key

# Custom Headers (JSON format)
WEAVIATE_HEADERS={"Authorization": "Bearer token"}

# Multi-Tenancy Configuration
WEAVIATE_MULTI_TENANCY_ENABLED=true
WEAVIATE_AUTO_TENANT_CREATION=true
WEAVIATE_AUTO_TENANT_ACTIVATION=true

# Environment Detection
NODE_ENV=development            # Used for Docker detection
```

## 🐳 Docker Configuration

### Docker Compose Example

```yaml
version: "3.8"
services:
  weaviate:
    container_name: social-sweep-weaviate
    image: semitechnologies/weaviate:latest
    restart: always
    environment:
      - QUERY_DEFAULTS_LIMIT=25
      - AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true
      - PERSISTENCE_DATA_PATH=/var/lib/weaviate
      - DEFAULT_VECTORIZER_MODULE=none
      - ENABLE_MODULES=text2vec-cohere,text2vec-huggingface,text2vec-palm,text2vec-openai,generative-openai,generative-cohere,generative-palm,ref2vec-centroid,reranker-cohere,qna-openai
      - CLUSTER_HOSTNAME=node1
    ports:
      - "8080:8080"
    volumes:
      - weaviate_data_social-sweep:/var/lib/weaviate

  api:
    container_name: social-sweep-api
    build: .
    restart: always
    env_file:
      - .env
    ports:
      - "3000:3000"
    depends_on:
      - weaviate
    volumes:
      - ./:/usr/src/app
      - /usr/src/app/node_modules

volumes:
  weaviate_data_social-sweep:
```

## 🔄 Automatic Configuration

The framework automatically detects the environment and configures the connection:

### Environment Detection

```typescript
// The framework automatically detects:
const isDockerEnv =
  process.env.NODE_ENV === "production" ||
  process.env.DOCKER_ENV ||
  process.env.HOSTNAME?.includes("docker") ||
  process.env.HOSTNAME?.length === 12; // Docker container IDs

const defaultHost = isDockerEnv ? "weaviate" : "localhost";
```

### Configuration Priority

1. **Environment Variables** (highest priority)
   - `WEAVIATE_HOST`
   - `WEAVIATE_PORT`
   - `WEAVIATE_SCHEME`

2. **Automatic Detection** (fallback)
   - Docker environment detection
   - Default to `localhost:8080` for local development

## 🚀 Initialization

### Basic Setup

```typescript
import { WeaviateConfigService } from "./WeaviateConfig.js";

// Initialize with environment variables
await WeaviateConfigService.initializeClient();
```

### Custom Configuration

```typescript
import { WeaviateConfigService } from "./WeaviateConfig.js";

// Initialize with custom config
await WeaviateConfigService.initializeClient({
  host: "custom-weaviate-host",
  port: 8080,
  scheme: "https",
  apiKey: "your-api-key",
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
});
```

## 🏢 Multi-Tenancy Configuration

### Environment Variables

```bash
# Enable multi-tenancy globally
WEAVIATE_MULTI_TENANCY_ENABLED=true

# Auto-create tenants when objects are inserted
WEAVIATE_AUTO_TENANT_CREATION=true

# Auto-activate inactive tenants
WEAVIATE_AUTO_TENANT_ACTIVATION=true
```

### Schema-Level Configuration

```typescript
const schema = {
  name: "UserDocuments",
  multiTenancy: {
    enabled: true,
    autoTenantCreation: true,
    autoTenantActivation: true,
  },
  // ... other schema config
};
```

### Tenant Management

```typescript
// Create tenants
await weaviate.createTenant("UserDocuments", { name: "acme-corp" });

// List tenants
const tenants = await weaviate.listTenants("UserDocuments");

// Update tenant status
await weaviate.updateTenant("UserDocuments", "acme-corp", {
  activityStatus: "COLD",
});
```

## 🔍 Health Checks

### Connection Testing

```typescript
import { WeaviateConfigService } from "./WeaviateConfig.js";

// Test connection
const isHealthy = await WeaviateConfigService.healthCheck();
console.log("Weaviate connection:", isHealthy ? "✅ Healthy" : "❌ Failed");

// Get cluster information
const clusterInfo = await WeaviateConfigService.getClusterInfo();
console.log("Cluster info:", clusterInfo);
```

## 🛠️ Troubleshooting

### Common Issues

#### Connection Refused

```bash
# Check if Weaviate is running
docker ps | grep weaviate

# Check Weaviate logs
docker logs social-sweep-weaviate

# Test connection manually
curl http://localhost:8080/v1/meta
```

#### Environment Variables Not Loaded

```bash
# Check if .env file exists
ls -la .env

# Verify environment variables
docker exec social-sweep-api printenv | grep WEAVIATE
```

#### Docker Service Name Issues

```bash
# Check Docker network
docker network ls

# Inspect container network
docker inspect social-sweep-api | grep NetworkMode
```

### Debug Mode

```typescript
// Enable debug logging
process.env.DEBUG = "weaviate:*";

// Or add to your .env file
DEBUG=weaviate:*
```

## 📊 Performance Tuning

### Connection Pooling

```typescript
// The framework automatically handles connection pooling
// No additional configuration needed
```

### Timeout Configuration

```typescript
// Default timeouts (can be customized in WeaviateConfig)
const config = {
  host: "weaviate",
  port: 8080,
  scheme: "http",
  timeout: 30000, // 30 seconds
};
```

## 🔐 Security

### API Key Authentication

```bash
# Add to your .env file
WEAVIATE_API_KEY=your-secure-api-key
```

### Custom Headers

```bash
# Add to your .env file
WEAVIATE_HEADERS={"Authorization": "Bearer your-token", "X-Custom-Header": "value"}
```

### HTTPS Configuration

```bash
# For production environments
WEAVIATE_SCHEME=https
WEAVIATE_HOST=your-secure-weaviate-host.com
```

## 📝 Configuration Examples

### Development Environment

```bash
# .env for local development
WEAVIATE_HOST=localhost
WEAVIATE_PORT=8080
WEAVIATE_SCHEME=http
NODE_ENV=development
```

### Production Environment

```bash
# .env for production
WEAVIATE_HOST=weaviate-cluster.prod.com
WEAVIATE_PORT=8080
WEAVIATE_SCHEME=https
WEAVIATE_API_KEY=prod-api-key
NODE_ENV=production
```

### Docker Environment

```bash
# .env for Docker
WEAVIATE_HOST=weaviate
WEAVIATE_PORT=8080
WEAVIATE_SCHEME=http
NODE_ENV=production
```

---

**Next Steps**: Once configured, proceed to the [Schema Guide](./SCHEMA_GUIDE.md) to learn how to define your data schemas.
