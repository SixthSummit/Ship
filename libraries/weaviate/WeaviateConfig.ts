import Logger from "@sixthsummit/ship-api/app/utils/Logger";
import {
  connectToCustom,
  connectToLocal,
  connectToWeaviateCloud,
  type WeaviateClient,
} from "weaviate-client";

export interface WeaviateConfig {
  host: string;
  port?: number;
  scheme?: "http" | "https";
  apiKey?: string;
  headers?: Record<string, string>;
  multiTenancy?: {
    enabled: boolean;
    autoTenantCreation?: boolean;
    autoTenantActivation?: boolean;
  };
}

export class WeaviateConfigService {
  private static client: WeaviateClient | null = null;
  private static lastHealthCheck: Date | null = null;
  private static healthCheckInterval = 60000; // 1 minute
  private static initializationPromise: Promise<WeaviateClient> | null = null;

  /**
   * Initialize Weaviate client with configuration
   * @param config - Optional configuration override
   * @param forceReinitialize - Force reinitialization even if client exists
   */
  public static async initializeClient(
    config?: WeaviateConfig,
    forceReinitialize = false,
  ): Promise<WeaviateClient> {
    if (WeaviateConfigService.client && !forceReinitialize) {
      return WeaviateConfigService.client;
    }

    // If currently initializing and not forcing reinit, wait for existing initialization
    if (WeaviateConfigService.initializationPromise && !forceReinitialize) {
      Logger.log("Weaviate client already initializing, waiting for completion...");
      return WeaviateConfigService.initializationPromise;
    }

    // Clear existing client if reinitializing
    if (forceReinitialize) {
      Logger.log("Reinitializing Weaviate client...");
      WeaviateConfigService.client = null;
      WeaviateConfigService.initializationPromise = null;
    }

    // Create initialization promise to prevent concurrent initializations
    WeaviateConfigService.initializationPromise = (async () => {
      try {
        const weaviateConfig = config || WeaviateConfigService.getDefaultConfig();

        // Determine connection method based on host
        if (
          weaviateConfig.host.includes("weaviate.cloud") ||
          weaviateConfig.host.includes("weaviate.network")
        ) {
          // Weaviate Cloud Services (WCS) - use authCredentials for API key
          Logger.log(`Connecting to Weaviate Cloud at ${weaviateConfig.host}`);

          // Skip gRPC health checks in CloudRun due to potential firewall/latency issues
          const skipInitChecks = process.env.WEAVIATE_SKIP_INIT_CHECKS === "true";
          if (skipInitChecks) {
            Logger.log("Skipping Weaviate gRPC health checks (WEAVIATE_SKIP_INIT_CHECKS=true)");
          }

          WeaviateConfigService.client = await connectToWeaviateCloud(weaviateConfig.host, {
            authCredentials: weaviateConfig.apiKey,
            headers: weaviateConfig.headers,
            skipInitChecks,
            timeout: {
              init: 30000, // 30 seconds for initialization
              query: 60000, // 60 seconds for queries
              insert: 120000, // 120 seconds for inserts/updates
            },
          });
        } else if (weaviateConfig.scheme === "https" || weaviateConfig.port === 443) {
          // Custom HTTPS deployment
          Logger.log(
            `Connecting to custom Weaviate at ${weaviateConfig.scheme}://${weaviateConfig.host}:${weaviateConfig.port}`,
          );
          WeaviateConfigService.client = await connectToCustom({
            httpHost: weaviateConfig.host,
            httpPort: weaviateConfig.port || 443,
            httpSecure: true,
            authCredentials: weaviateConfig.apiKey ? { apiKey: weaviateConfig.apiKey } : undefined,
            headers: weaviateConfig.headers,
            timeout: {
              init: 30000,
              query: 60000,
              insert: 120000,
            },
          });
        } else {
          // Local or HTTP deployment
          Logger.log(
            `Connecting to local Weaviate at ${weaviateConfig.host}:${weaviateConfig.port}`,
          );
          WeaviateConfigService.client = await connectToLocal({
            host: weaviateConfig.host,
            port: weaviateConfig.port || 8080,
            authCredentials: weaviateConfig.apiKey ? { apiKey: weaviateConfig.apiKey } : undefined,
            headers: weaviateConfig.headers,
            timeout: {
              init: 30000,
              query: 60000,
              insert: 120000,
            },
          });
        }

        // Test the connection
        await WeaviateConfigService.client.getMeta();
        Logger.log("Weaviate client initialized successfully");

        return WeaviateConfigService.client;
      } catch (error) {
        Logger.log("Error initializing Weaviate client:", error);
        WeaviateConfigService.client = null;
        WeaviateConfigService.initializationPromise = null;
        throw error;
      }
    })();

    try {
      const client = await WeaviateConfigService.initializationPromise;
      WeaviateConfigService.initializationPromise = null;
      return client;
    } catch (error) {
      WeaviateConfigService.initializationPromise = null;
      throw error;
    }
  }

  /**
   * Get the initialized client with optional health check
   * Lazily initializes the client if not already initialized
   * @param skipHealthCheck - Skip health check (default: false)
   */
  public static async getClient(skipHealthCheck = false): Promise<WeaviateClient> {
    // Lazy initialization - initialize on first access if needed
    if (!WeaviateConfigService.client && !WeaviateConfigService.initializationPromise) {
      Logger.log("Weaviate client not initialized, initializing lazily...");
      await WeaviateConfigService.initializeClient();
    }

    // Wait for initialization to complete if in progress
    if (WeaviateConfigService.initializationPromise) {
      await WeaviateConfigService.initializationPromise;
    }

    if (!WeaviateConfigService.client) {
      throw new Error("Weaviate client initialization failed");
    }

    // Periodic health check to detect stale connections
    // Health check is best-effort - we don't crash if it fails
    if (!skipHealthCheck) {
      const now = new Date();
      const shouldCheck =
        !WeaviateConfigService.lastHealthCheck ||
        now.getTime() - WeaviateConfigService.lastHealthCheck.getTime() >
          WeaviateConfigService.healthCheckInterval;

      if (shouldCheck) {
        try {
          await WeaviateConfigService.client.getMeta();
          WeaviateConfigService.lastHealthCheck = now;
        } catch (error) {
          Logger.error("Weaviate health check failed, attempting reconnection:", error);
          // Attempt to reinitialize - but don't crash if it fails
          // The existing client might still work for some operations
          try {
            await WeaviateConfigService.initializeClient(undefined, true);
            Logger.log("Weaviate client reconnected successfully");
          } catch (reconnectError) {
            Logger.error(
              "Failed to reconnect to Weaviate (will retry on next health check):",
              reconnectError,
            );
            // Don't throw - return the existing client and let individual operations fail/retry
            // This prevents the worker from crashing on transient network issues
            WeaviateConfigService.lastHealthCheck = now; // Prevent immediate retry storm
          }
        }
      }
    }

    return WeaviateConfigService.client;
  }

  /**
   * Get the initialized client synchronously (use with caution)
   * This version doesn't perform health checks
   */
  public static getClientSync(): WeaviateClient {
    if (!WeaviateConfigService.client) {
      throw new Error("Weaviate client not initialized. Call initializeClient() first.");
    }
    return WeaviateConfigService.client;
  }

  /**
   * Get default configuration from environment variables
   */
  private static getDefaultConfig(): WeaviateConfig {
    return {
      host: process.env.WEAVIATE_HOST || "localhost",
      port: parseInt(process.env.WEAVIATE_PORT || "8080", 10),
      scheme: (process.env.WEAVIATE_SCHEME as "http" | "https") || "http",
      apiKey: process.env.WEAVIATE_API_KEY,
      headers: process.env.WEAVIATE_HEADERS ? JSON.parse(process.env.WEAVIATE_HEADERS) : undefined,
      multiTenancy: {
        enabled: process.env.WEAVIATE_MULTI_TENANCY_ENABLED === "true",
        autoTenantCreation: process.env.WEAVIATE_AUTO_TENANT_CREATION !== "false",
        autoTenantActivation: process.env.WEAVIATE_AUTO_TENANT_ACTIVATION !== "false",
      },
    };
  }

  /**
   * Health check for Weaviate connection
   */
  public static async healthCheck(): Promise<boolean> {
    try {
      if (!WeaviateConfigService.client) {
        return false;
      }

      await WeaviateConfigService.client.getMeta();
      return true;
    } catch (error) {
      Logger.log("Weaviate health check failed:", error);
      return false;
    }
  }

  /**
   * Get cluster information
   */
  public static async getClusterInfo(): Promise<any> {
    if (!WeaviateConfigService.client) {
      throw new Error("Weaviate client not initialized");
    }

    try {
      return await WeaviateConfigService.client.getMeta();
    } catch (error) {
      Logger.log("Error getting cluster info:", error);
      throw error;
    }
  }

  /**
   * Reset the client (useful for testing)
   */
  public static resetClient(): void {
    WeaviateConfigService.client = null;
    WeaviateConfigService.initializationPromise = null;
    WeaviateConfigService.lastHealthCheck = null;
  }
}
