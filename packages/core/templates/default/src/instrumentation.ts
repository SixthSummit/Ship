/**
 * Telemetry bootstrap boundary. Keep this module independent from application
 * code so the SDK starts before HTTP, database, Redis, or logging libraries
 * are loaded. Direct environment reads are intentional at this early boundary:
 * importing the application's validated environment would load the framework.
 */
import { startOtel } from "@sixthsummit/ship-observability-otel/sdk";

startOtel({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "ship-api-app",
  serviceVersion: process.env.npm_package_version,
  environmentName: process.env.ENVIRONMENT_NAME ?? process.env.NODE_ENV,
});
