/**
 * Public surface for `@sixthsummit/ship-api-mcp-server`.
 *
 * Most consumers run this package as a binary (`npx ship-api-mcp-server`)
 * — see `server.ts`. The exports below let advanced consumers embed the
 * tools in their own MCP server, write tests against the registry, or
 * build a custom transport.
 */

export {
  HttpRegistryClient,
  type HttpRegistryClientOptions,
  type RegistryClient,
  StaticRegistryClient,
} from "./registryClient.js";
export { type BuildServerOptions, buildServer, main, PACKAGE_VERSION } from "./server.js";

export {
  type DescribeRouteArgs,
  type DescribeRouteResult,
  describeRoute,
  type FindRouteCollisionsArgs,
  type FindRouteCollisionsResult,
  findRouteCollisions,
  type ListRoutesArgs,
  type ListRoutesResult,
  listRoutes,
} from "./tools/index.js";
export type { JsonSchema, RouteEntry, RouteFilter, RouteMethod, RoutesDump } from "./types.js";
