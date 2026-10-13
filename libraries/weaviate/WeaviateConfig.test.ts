import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectToCustom,
  connectToLocal,
  connectToWeaviateCloud,
  type WeaviateClient,
} from "weaviate-client";
import { type WeaviateConfig, WeaviateConfigService } from "./WeaviateConfig.js";

// Mock the Logger
vi.mock("@sixthsummit/ship-api/app/utils/Logger", () => ({
  default: {
    log: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock WeaviateClient
vi.mock("weaviate-client", () => ({
  WeaviateClient: vi.fn().mockImplementation(() => ({
    getMeta: vi.fn().mockResolvedValue({ version: "1.0.0" }),
  })),
  connectToLocal: vi.fn().mockResolvedValue({
    getMeta: vi.fn().mockResolvedValue({ version: "1.0.0" }),
  }),
  connectToCustom: vi.fn().mockResolvedValue({
    getMeta: vi.fn().mockResolvedValue({ version: "1.0.0" }),
  }),
  connectToWeaviateCloud: vi.fn().mockResolvedValue({
    getMeta: vi.fn().mockResolvedValue({ version: "1.0.0" }),
  }),
}));

describe("WeaviateConfigService", () => {
  let mockWeaviateClient: vi.Mocked<WeaviateClient>;

  beforeEach(() => {
    WeaviateConfigService.resetClient(); // Reset for each test

    // Create mock client
    mockWeaviateClient = {
      getMeta: vi.fn().mockResolvedValue({ version: "1.0.0" }),
    } as any;

    // Mock all connection functions
    (connectToLocal as any).mockResolvedValue(mockWeaviateClient);
    (connectToCustom as any).mockResolvedValue(mockWeaviateClient);
    (connectToWeaviateCloud as any).mockResolvedValue(mockWeaviateClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
    WeaviateConfigService.resetClient();
  });

  describe("initializeClient", () => {
    it("should initialize client with default config", async () => {
      // Mock environment variables
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WEAVIATE_HOST: "localhost",
        WEAVIATE_PORT: "8080",
        WEAVIATE_SCHEME: "http",
      };

      const client = await WeaviateConfigService.initializeClient();

      expect(connectToLocal).toHaveBeenCalledWith({
        host: "localhost",
        port: 8080,
        authCredentials: undefined,
        headers: undefined,
        timeout: {
          init: 30000,
          query: 60000,
          insert: 120000,
        },
      });
      expect(client).toBe(mockWeaviateClient);
      expect(mockWeaviateClient.getMeta).toHaveBeenCalled();

      process.env = originalEnv;
    });

    it("should initialize client with custom config", async () => {
      const customConfig: WeaviateConfig = {
        host: "custom-host",
        port: 9999,
        scheme: "https",
        apiKey: "test-key",
        headers: { "X-Custom": "value" },
      };

      const client = await WeaviateConfigService.initializeClient(customConfig);

      // HTTPS config should use connectToCustom
      expect(connectToCustom).toHaveBeenCalledWith({
        httpHost: "custom-host",
        httpPort: 9999,
        httpSecure: true,
        authCredentials: { apiKey: "test-key" },
        headers: { "X-Custom": "value" },
        timeout: {
          init: 30000,
          query: 60000,
          insert: 120000,
        },
      });
      expect(client).toBe(mockWeaviateClient);
    });

    it("should return existing client if already initialized", async () => {
      await WeaviateConfigService.initializeClient();
      const client1 = await WeaviateConfigService.getClient(true); // Skip health check

      const client2 = await WeaviateConfigService.initializeClient();

      expect(client1).toBe(client2);
      expect(connectToLocal).toHaveBeenCalledTimes(1);
    });

    it("should force reinitialization when requested", async () => {
      await WeaviateConfigService.initializeClient();
      const client1 = await WeaviateConfigService.getClient(true);

      const client2 = await WeaviateConfigService.initializeClient(undefined, true);

      expect(client1).toBeDefined();
      expect(client2).toBe(mockWeaviateClient);
      expect(connectToLocal).toHaveBeenCalledTimes(2); // Called twice
    });

    it("should handle initialization errors", async () => {
      mockWeaviateClient.getMeta.mockRejectedValue(new Error("Connection failed"));

      await expect(WeaviateConfigService.initializeClient()).rejects.toThrow("Connection failed");
    });
  });

  describe("getClient", () => {
    it("should return initialized client with health check", async () => {
      await WeaviateConfigService.initializeClient();
      const client = await WeaviateConfigService.getClient();
      expect(client).toBe(mockWeaviateClient);
      expect(mockWeaviateClient.getMeta).toHaveBeenCalled(); // Health check
    });

    it("should skip health check when requested", async () => {
      await WeaviateConfigService.initializeClient();
      mockWeaviateClient.getMeta.mockClear(); // Clear previous calls

      const client = await WeaviateConfigService.getClient(true); // Skip health check
      expect(client).toBe(mockWeaviateClient);
      expect(mockWeaviateClient.getMeta).not.toHaveBeenCalled();
    });

    it("should lazily initialize client if not already initialized", async () => {
      // Don't call initializeClient first - should auto-initialize
      const client = await WeaviateConfigService.getClient(true); // Skip health check

      expect(client).toBe(mockWeaviateClient);
      expect(connectToLocal).toHaveBeenCalledTimes(1);
    });

    it("should automatically reconnect on health check failure", async () => {
      await WeaviateConfigService.initializeClient();

      // First health check fails, then reinitialize succeeds
      mockWeaviateClient.getMeta
        .mockRejectedValueOnce(new Error("Connection lost"))
        .mockResolvedValueOnce({ version: "1.0.0" }); // Reinitialize check

      // Should reconnect successfully
      const client = await WeaviateConfigService.getClient();
      expect(client).toBe(mockWeaviateClient);
    });
  });

  describe("getClient - lazy initialization", () => {
    it("should initialize client lazily when not yet initialized", async () => {
      // Don't call initializeClient first - test lazy init
      const client = await WeaviateConfigService.getClient(true); // Skip health check

      expect(client).toBe(mockWeaviateClient);
      expect(connectToLocal).toHaveBeenCalledTimes(1);
    });

    it("should throw error if initialization fails during lazy init", async () => {
      mockWeaviateClient.getMeta.mockRejectedValue(new Error("Connection failed"));

      await expect(WeaviateConfigService.getClient()).rejects.toThrow("Connection failed");
    });
  });

  describe("healthCheck", () => {
    it("should return true when client is healthy", async () => {
      await WeaviateConfigService.initializeClient();
      mockWeaviateClient.getMeta.mockResolvedValue({ version: "1.0.0" });

      const result = await WeaviateConfigService.healthCheck();
      expect(result).toBe(true);
    });

    it("should return false when client is not initialized", async () => {
      const result = await WeaviateConfigService.healthCheck();
      expect(result).toBe(false);
    });

    it("should return false when health check fails", async () => {
      await WeaviateConfigService.initializeClient();
      mockWeaviateClient.getMeta.mockRejectedValue(new Error("Health check failed"));

      const result = await WeaviateConfigService.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe("getClusterInfo", () => {
    it("should return cluster information", async () => {
      await WeaviateConfigService.initializeClient();
      const mockInfo = { version: "1.0.0", modules: {} };
      mockWeaviateClient.getMeta.mockResolvedValue(mockInfo);

      const result = await WeaviateConfigService.getClusterInfo();
      expect(result).toEqual(mockInfo);
    });

    it("should throw error if client not initialized", async () => {
      await expect(WeaviateConfigService.getClusterInfo()).rejects.toThrow(
        "Weaviate client not initialized",
      );
    });

    it("should handle errors when getting cluster info", async () => {
      await WeaviateConfigService.initializeClient();
      mockWeaviateClient.getMeta.mockRejectedValue(new Error("Cluster info failed"));

      await expect(WeaviateConfigService.getClusterInfo()).rejects.toThrow("Cluster info failed");
    });
  });

  describe("resetClient", () => {
    it("should reset client to null", async () => {
      await WeaviateConfigService.initializeClient();
      const client = await WeaviateConfigService.getClient(true);
      expect(client).toBeDefined();

      WeaviateConfigService.resetClient();

      // After reset, next getClient should re-initialize
      vi.clearAllMocks();
      const newClient = await WeaviateConfigService.getClient(true);
      expect(newClient).toBeDefined();
      expect(connectToLocal).toHaveBeenCalledTimes(1); // Called again after reset
    });
  });

  describe("default configuration", () => {
    it("should use environment variables for default config", async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WEAVIATE_HOST: "env-host",
        WEAVIATE_PORT: "9090",
        WEAVIATE_SCHEME: "https",
        WEAVIATE_API_KEY: "env-key",
        WEAVIATE_HEADERS: '{"X-Env": "value"}',
      };

      await WeaviateConfigService.initializeClient();

      // HTTPS scheme should use connectToCustom
      expect(connectToCustom).toHaveBeenCalledWith({
        httpHost: "env-host",
        httpPort: 9090,
        httpSecure: true,
        authCredentials: { apiKey: "env-key" },
        headers: { "X-Env": "value" },
        timeout: {
          init: 30000,
          query: 60000,
          insert: 120000,
        },
      });

      process.env = originalEnv;
    });

    it("should handle invalid JSON in WEAVIATE_HEADERS", async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WEAVIATE_HEADERS: "invalid-json",
      };

      await expect(WeaviateConfigService.initializeClient()).rejects.toThrow();

      process.env = originalEnv;
    });
  });
});
