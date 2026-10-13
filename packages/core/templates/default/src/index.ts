/**
 * Process bootstrap. Instrumentation is the only static runtime import:
 * ESM evaluates every static dependency before running this body, so loading
 * the application here would make auto-instrumentation too late.
 */
import "./instrumentation.js";

await import("./server.js");

// Type-only exports are erased and therefore do not load `server.js` early.
export type { ShipApiClient } from "./server.js";
