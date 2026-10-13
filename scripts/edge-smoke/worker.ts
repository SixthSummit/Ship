/**
 * Edge-runtime smoke test fixture.
 *
 * `wrangler deploy --dry-run --outdir tmp/wrangler-out` against this
 * file proves the operation kernel and generated Hono adapter compile for
 * Cloudflare Workers.
 *
 * IMPORTANT: this file imports a deliberately narrow slice of the
 * framework — only the explicit `kernel` and `hono` subpaths that are claimed
 * to be edge-compatible. If you find yourself adding
 * imports from `app/observability/`, `app/services/jobs/`,
 * `app/db/client`, or similar Node-coupled modules, STOP — that's
 * the regression this smoke test exists to catch. Either:
 *   1. The import doesn't actually belong in the http/ layer (push it
 *      into the consumer's runtime composition); or
 *   2. The framework's edge-runtime story changed and this test
 *      needs a follow-up to add the appropriate adapter.
 */

import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import {
  defineApp,
  defineModule,
  defineOperation,
  publicAccess,
  type RuntimeSchema,
} from "@sixthsummit/ship-core";
import { createHonoAdapter, http } from "@sixthsummit/ship-hono";

// Tiny worker that exercises the real operation-to-Hono path without Node-only
// runtime services. Real apps compose more; this fixture proves the claimed
// edge-safe package seam rather than merely bundling Hono itself.

const paramsSchema = schema<{ readonly msg: string }>((value) => {
  if (typeof value !== "object" || value === null) return undefined;
  const msg = Reflect.get(value, "msg");
  return typeof msg === "string" ? { msg } : undefined;
});
const echoSchema = schema<{ readonly echo: string; readonly edge: true }>((value) => {
  if (typeof value !== "object" || value === null) return undefined;
  const echo = Reflect.get(value, "echo");
  return typeof echo === "string" && Reflect.get(value, "edge") === true
    ? { echo, edge: true }
    : undefined;
});

const echo = defineOperation({
  id: "edge.echo",
  transport: http.get("/echo/:msg"),
  input: { params: paramsSchema },
  output: { 200: echoSchema },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: ({ input }) => ({ echo: input.params.msg, edge: true }),
});
const edgeModule = defineModule({
  id: "edge",
  operations: [echo],
  providers: [],
  imports: [],
  exports: [],
});
const application = defineApp({ id: "edge-smoke", modules: [edgeModule] });
const app = createHonoAdapter(application);
type EdgeClientContract = {
  readonly operations: {
    readonly "edge.echo": {
      readonly transport: "http";
      readonly input: { readonly params: { readonly msg: string } };
      readonly result: {
        readonly ok: true;
        readonly status: 200;
        readonly data: { readonly echo: string; readonly edge: true };
      };
    };
  };
};
const client = createHttpOperationClient<EdgeClientContract>(
  {
    schemaVersion: 1,
    appId: "edge-smoke",
    fingerprint: `sha256:${"0".repeat(64)}`,
    operations: [],
  },
  { baseUrl: "https://api.example.test" },
);
void client;

function schema<TOutput>(
  parse: (value: unknown) => TOutput | undefined,
): RuntimeSchema<unknown, TOutput> {
  return {
    "~standard": {
      version: 1,
      vendor: "edge-smoke",
      validate: (value) => {
        const output = parse(value);
        return output === undefined
          ? { issues: [{ message: "edge smoke schema rejected value" }] }
          : { value: output };
      },
    },
  };
}

export default {
  fetch: app.fetch,
};
