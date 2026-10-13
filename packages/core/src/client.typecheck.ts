/**
 * Type-level CI guard for `ShipApiSuccessClient<TApp>` (client.ts).
 *
 * `.test.ts` files are excluded from `tsconfig.check.json`, so a runtime test
 * in client.test.ts does NOT guard the type narrowing. This file IS type-checked
 * (`npm run type-check`) and fails the build if `ShipApiSuccessClient` ever stops
 * narrowing to the success-status (200|201) response body.
 */
import { Hono } from "hono";
import type { ShipApiSuccessClient } from "./client.js";

// A route with both a 200 success body and a 400 error body. (Branch on a
// header — not c.req.param — so the no-raw-access lint rule stays happy.)
const _app = new Hono().get("/widget/:id", (c) =>
  c.req.header("x-missing")
    ? c.json({ error: "not found" }, 400)
    : c.json({ id: "1", name: "w" }, 200),
);

declare const _api: ShipApiSuccessClient<typeof _app>;

// The success-only client's `.json()` return for this route (path /widget/:id).
type SuccessBody = Awaited<
  ReturnType<Awaited<ReturnType<(typeof _api.widget)[":id"]["$get"]>>["json"]>
>;

type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Must equal the 200 body EXACTLY — if the 400 `{ error: string }` variant
// leaked back in, this union would no longer equal `{ id; name }` and fail.
type _successOnly = Assert<Equals<SuccessBody, { id: string; name: string }>>;
