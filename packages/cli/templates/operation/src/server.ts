import { serve } from "@hono/node-server";
import { createHttp } from "./http.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

// CORS comes from the CORS_ORIGINS allowlist; see src/http.ts.
const http = createHttp();
serve({ fetch: http.fetch, port }, ({ port: listeningPort }) => {
  process.stdout.write(`{{PACKAGE_NAME}} listening on ${listeningPort}\n`);
});
