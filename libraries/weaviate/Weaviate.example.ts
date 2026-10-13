/**
 * Example usage of the Weaviate framework
 * This demonstrates the generalized, schema-driven approach
 */

import { QueryPatterns } from "./QueryBuilder.js";
import Weaviate from "./Weaviate.js";
import { WeaviateConfigService } from "./WeaviateConfig.js";

// Example: Initialize the weaviate
async function initialize() {
  try {
    console.log("Initializing Weaviate...");

    // Initialize Weaviate client
    await WeaviateConfigService.initializeClient();

    // Create weaviate instance
    const weaviate = new Weaviate();

    // Initialize schemas (define your own or load from a config file)
    // Example: const schemas = [PersonSchema, OrganizationSchema];
    // await weaviate.initializeSchemas(schemas);

    console.log("Weaviate initialized successfully");
    return weaviate;
  } catch (error) {
    console.error("Error initializing Weaviate:", error);
    throw error;
  }
}

// Example: Generic search across any schema
async function genericSearchExample(weaviate: Weaviate) {
  try {
    console.log("=== Generic Search Examples ===");

    // Search people with vector search
    const peopleResults = await weaviate.search("Person", {
      method: "vector",
      options: {
        nearText: {
          concepts: ["software engineer"],
          certainty: 0.7,
        },
        limit: 5,
      },
    });
    console.log(`Found ${peopleResults.objects.length} people with vector search`);

    // Search organizations with hybrid search
    const orgResults = await weaviate.search("Organization", {
      method: "hybrid",
      options: {
        hybrid: {
          query: "tech startup",
          alpha: 0.6,
        },
        limit: 3,
      },
    });
    console.log(`Found ${orgResults.objects.length} organizations with hybrid search`);

    // Search conversations with BM25
    const convResults = await weaviate.search("Conversation", {
      method: "bm25",
      options: {
        bm25: {
          query: "machine learning",
        },
        limit: 3,
      },
    });
    console.log(`Found ${convResults.objects.length} conversations with BM25 search`);

    return { peopleResults, orgResults, convResults };
  } catch (error) {
    console.error("Error in generic search:", error);
    throw error;
  }
}

// Example: Smart search with automatic method selection
async function smartSearchExample(weaviate: Weaviate) {
  try {
    console.log("=== Smart Search Examples ===");

    // Smart search will automatically choose the best method
    const smartResults1 = await weaviate.smartSearch("Person", "John Smith");
    console.log(`Smart search for "John Smith": ${smartResults1.objects.length} results`);

    const smartResults2 = await weaviate.smartSearch("Person", "machine learning engineer");
    console.log(
      `Smart search for "machine learning engineer": ${smartResults2.objects.length} results`,
    );

    const smartResults3 = await weaviate.smartSearch("Person", '"senior developer"');
    console.log(`Smart search for exact phrase: ${smartResults3.objects.length} results`);

    return { smartResults1, smartResults2, smartResults3 };
  } catch (error) {
    console.error("Error in smart search:", error);
    throw error;
  }
}

// Example: Query builder usage
async function queryBuilderExample(weaviate: Weaviate) {
  try {
    console.log("=== Query Builder Examples ===");

    // Create a query builder for Person schema
    const personQuery = weaviate
      .queryBuilder("Person")
      .limit(10)
      .whereField("city", "Equal", "San Francisco")
      .sort("createdAt", "desc")
      .includeVector();

    // Build vector search
    const vectorOptions = personQuery.buildVectorSearch("software engineer", {
      certainty: 0.8,
    });

    const vectorResults = await weaviate.search("Person", {
      method: "vector",
      options: vectorOptions,
    });
    console.log(`Query builder vector search: ${vectorResults.objects.length} results`);

    // Build hybrid search
    const hybridOptions = personQuery.buildHybridSearch("data scientist", {
      alpha: 0.5,
    });

    const hybridResults = await weaviate.search("Person", {
      method: "hybrid",
      options: hybridOptions,
    });
    console.log(`Query builder hybrid search: ${hybridResults.objects.length} results`);

    return { vectorResults, hybridResults };
  } catch (error) {
    console.error("Error in query builder:", error);
    throw error;
  }
}

// Example: Query patterns usage
async function queryPatternsExample(weaviate: Weaviate) {
  try {
    console.log("=== Query Patterns Examples ===");

    // Date range search
    const dateRangeQuery = QueryPatterns.dateRange(
      "createdAt",
      new Date("2023-01-01"),
      new Date("2023-12-31"),
    );

    const dateResults = await weaviate.search("Person", {
      method: "vector",
      options: {
        ...dateRangeQuery.build(),
        nearText: { concepts: ["engineer"] },
      },
    });
    console.log(`Date range search: ${dateResults.objects.length} results`);

    // Text contains search
    const textContainsQuery = QueryPatterns.textContains("headline", "senior");
    const textResults = await weaviate.search("Person", {
      method: "bm25",
      options: {
        ...textContainsQuery.build(),
        bm25: { query: "senior" },
      },
    });
    console.log(`Text contains search: ${textResults.objects.length} results`);

    // Multiple values search
    const inValuesQuery = QueryPatterns.inValues("city", ["San Francisco", "New York", "Seattle"]);
    const multiResults = await weaviate.search("Person", {
      method: "vector",
      options: {
        ...inValuesQuery.build(),
        nearText: { concepts: ["developer"] },
      },
    });
    console.log(`Multiple values search: ${multiResults.objects.length} results`);

    return { dateResults, textResults, multiResults };
  } catch (error) {
    console.error("Error in query patterns:", error);
    throw error;
  }
}

// Example: Universal search across multiple schemas
async function universalSearchExample(weaviate: Weaviate) {
  try {
    console.log("=== Universal Search Examples ===");

    // Search across multiple schemas with hybrid search
    const allResults = await weaviate.searchAll(
      ["Person", "Organization", "Conversation", "Message"],
      {
        method: "hybrid",
        options: {
          hybrid: {
            query: "artificial intelligence",
            alpha: 0.6,
          },
          limit: 3,
        },
      },
    );

    console.log("Universal search results:");
    Object.entries(allResults).forEach(([schema, result]: [string, any]) => {
      console.log(`  ${schema}: ${result.objects.length} results`);
    });

    return allResults;
  } catch (error) {
    console.error("Error in universal search:", error);
    throw error;
  }
}

// Example: Schema information and statistics
async function schemaInfoExample(weaviate: Weaviate) {
  try {
    console.log("=== Schema Information ===");

    // Get schema information
    const personInfo = weaviate.getSchemaInfo("Person");
    console.log("Person schema info:");
    console.log(`  Searchable fields: ${personInfo.searchableFields.join(", ")}`);
    console.log(`  Filterable fields: ${personInfo.filterableFields.join(", ")}`);
    console.log(`  Sortable fields: ${personInfo.sortableFields.join(", ")}`);
    console.log(`  Plugins: ${personInfo.plugins.map((p) => p.name).join(", ")}`);

    // Get weaviate statistics
    const stats = weaviate.getStats();
    console.log("Framework statistics:");
    console.log(`  Total schemas: ${stats.registry.totalSchemas}`);
    console.log(`  Total plugins: ${stats.registry.totalPlugins}`);
    console.log(`  Schemas by category:`, stats.registry.schemasByCategory);

    return { personInfo, stats };
  } catch (error) {
    console.error("Error getting schema info:", error);
    throw error;
  }
}

// Example: Custom schema registration
async function customSchemaExample(weaviate: Weaviate) {
  try {
    console.log("=== Custom Schema Example ===");

    // Define a custom schema
    const customSchema = {
      name: "Product",
      description: "A product in the catalog",
      vectorizer: {
        name: "text2vec-cohere",
        model: "embed-multilingual-v3.0",
      },
      vectorIndexConfig: {
        distance: "cosine" as const,
        ef: 64,
        efConstruction: 128,
        maxConnections: 16,
      },
      properties: [
        {
          name: "name",
          dataType: ["string"],
          description: "Product name",
          indexInverted: true,
          indexSearchable: true,
          weight: 2.0,
        },
        {
          name: "description",
          dataType: ["string"],
          description: "Product description",
          indexInverted: true,
          indexSearchable: true,
          weight: 1.0,
        },
        {
          name: "category",
          dataType: ["string"],
          description: "Product category",
          indexInverted: true,
          indexFilterable: true,
          weight: 1.0,
        },
        {
          name: "price",
          dataType: ["number"],
          description: "Product price",
          indexInverted: true,
          indexFilterable: true,
        },
      ],
      searchableFields: ["name", "description"],
      filterableFields: ["category", "price"],
      sortableFields: ["name", "price"],
      metadata: {
        category: "catalog",
        priority: "medium",
      },
    };

    // Register the custom schema
    weaviate.registerSchema(customSchema);
    console.log("Custom Product schema registered");

    // Now you can search the custom schema
    const productResults = await weaviate.search("Product", {
      method: "hybrid",
      options: {
        hybrid: {
          query: "laptop computer",
          alpha: 0.5,
        },
        limit: 5,
      },
    });
    console.log(`Custom schema search: ${productResults.objects.length} results`);

    return productResults;
  } catch (error) {
    console.error("Error with custom schema:", error);
    throw error;
  }
}

// Example: Complete workflow
async function completeWorkflowExample() {
  try {
    console.log("Starting WeaviateFramework complete workflow...");

    // Initialize weaviate
    const weaviate = await initialize();

    // Generic search examples
    await genericSearchExample(weaviate);

    // Smart search examples
    await smartSearchExample(weaviate);

    // Query builder examples
    await queryBuilderExample(weaviate);

    // Query patterns examples
    await queryPatternsExample(weaviate);

    // Universal search examples
    await universalSearchExample(weaviate);

    // Schema information
    await schemaInfoExample(weaviate);

    // Custom schema example
    await customSchemaExample(weaviate);

    // Health check
    const isHealthy = await weaviate.healthCheck();
    console.log(`Framework health check: ${isHealthy ? "healthy" : "unhealthy"}`);

    console.log("WeaviateFramework complete workflow finished successfully!");
  } catch (error) {
    console.error("Error in complete workflow:", error);
  }
}

// Export examples for use in other files
export {
  initialize,
  genericSearchExample,
  smartSearchExample,
  queryBuilderExample,
  queryPatternsExample,
  universalSearchExample,
  schemaInfoExample,
  customSchemaExample,
  completeWorkflowExample,
};
