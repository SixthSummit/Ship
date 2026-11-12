import {
  defineApp,
  defineModule,
  defineOperation,
  publicAccess,
  type RuntimeSchema,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";

/**
 * Three unrelated operations for the merge story: `left` changes only
 * `accounts.read`, `right` changes only `reports.summary`, and `orders.list`
 * never changes. The contract CLI test emits the artifacts for every variant
 * and three-way-merges them with `git merge-file`.
 */
export type MergeFixtureVariant = "base" | "left" | "right";

const base = { errors: [], access: publicAccess(), transaction: "none", dependencies: {} } as const;
const fixtureOnly = (): never => {
  throw new Error("contract-merge fixture operations are never executed");
};

export function mergeFixtureApp(variant: MergeFixtureVariant) {
  const accountOutput: RuntimeSchema =
    variant === "left"
      ? z.object({ accountId: z.string(), displayName: z.string() })
      : z.object({ accountId: z.string() });
  const reportQuery: RuntimeSchema =
    variant === "right"
      ? z.object({ from: z.string(), to: z.string(), limit: z.number().int().optional() })
      : z.object({ from: z.string(), to: z.string() });

  const readAccount = defineOperation({
    ...base,
    id: "accounts.read",
    transport: http.get("/accounts/:accountId"),
    input: { params: z.object({ accountId: z.string() }) },
    output: { 200: accountOutput },
    successStatus: 200,
    handler: fixtureOnly,
  });
  const listOrders = defineOperation({
    ...base,
    id: "orders.list",
    transport: http.get("/orders"),
    input: { query: z.object({ status: z.enum(["open", "closed"]) }) },
    output: { 200: z.object({ orders: z.array(z.object({ orderId: z.string() })) }) },
    successStatus: 200,
    handler: fixtureOnly,
  });
  const summarizeReports = defineOperation({
    ...base,
    id: "reports.summary",
    transport: http.get("/reports/summary"),
    input: { query: reportQuery },
    output: { 200: z.object({ total: z.number() }) },
    successStatus: 200,
    handler: fixtureOnly,
  });

  return defineApp({
    id: "contract-merge-fixture",
    modules: [
      defineModule({
        id: "accounts",
        operations: [readAccount],
        providers: [],
        imports: [],
        exports: [],
      }),
      defineModule({
        id: "orders",
        operations: [listOrders],
        providers: [],
        imports: [],
        exports: [],
      }),
      defineModule({
        id: "reports",
        operations: [summarizeReports],
        providers: [],
        imports: [],
        exports: [],
      }),
    ],
  });
}
