/**
 * Compile-time contract check for the typed-client chain — no runtime, no
 * test runner. This file is included in `tsc --noEmit` (tsconfig.check.json
 * picks up `modules/**`, and `*.test.ts` files are excluded from typecheck),
 * so CI fails if the contract regresses.
 *
 * The contract: every `defineXxxRoutes` is generic over Hono's schema
 * parameter (`<S extends Schema>(app: Hono<AppEnv, S>, deps)`) and returns
 * the chained app. A non-generic `app: Hono<AppEnv>` signature widens an
 * already-chained app — `.get()`/`.post()` resolve on the parameter's
 * declared type — so composing a second module erases the first module's
 * routes from the `hc<ShipApiClient>()` client type. That shipped once:
 * the scaffold exported a `ShipApiClient` that typed zero routes, and
 * nothing caught it because no compile consumed the type. This file is
 * that consumer.
 */

import type { AppEnv } from "@sixthsummit/ship-api/http/app/createApp";
import type { Hono } from "hono";
import type { hc } from "hono/client";

import { type AccountsRoutesDeps, defineAccountsRoutes } from "./accounts/index.js";
import { defineOAuthRoutes, type OAuthRoutesDeps } from "./oauth/index.js";
import { defineOutboxRoutes, type OutboxRoutesDeps } from "./outbox/index.js";

declare const app: Hono<AppEnv>;
declare const accountsDeps: AccountsRoutesDeps;
declare const oauthDeps: OAuthRoutesDeps;
declare const outboxDeps: OutboxRoutesDeps;

// Threaded composition via the kept `defineXxxRoutes(app, deps)` escape hatch
// (the canonical pattern is `root.route("/", buildXxxApp(deps))`). Pinned here
// to prove the back-compat hatch still type-accumulates every module's routes.
const _routed = defineOutboxRoutes(
  defineOAuthRoutes(defineAccountsRoutes(app, accountsDeps), oauthDeps),
  outboxDeps,
);

type Client = ReturnType<typeof hc<typeof _routed>>;

type Assert<T extends true> = T;
type IsFunction<T> = T extends (...args: never[]) => unknown ? true : false;

// One route per module — if any definer widens the chain, the earlier
// modules' keys disappear from `Client` and these lines fail to compile.
export type AccountsRouteSurvivesChain = Assert<IsFunction<Client["accounts"]["$get"]>>;
export type OAuthRouteSurvivesChain = Assert<IsFunction<Client["oauth"]["$get"]>>;
export type OutboxRouteSurvivesChain = Assert<IsFunction<Client["outbox"]["$get"]>>;
