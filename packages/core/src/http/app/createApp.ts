import { type Context, type Env, Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import {
  type HttpMethod,
  type RouteEntry,
  type RouteRegistry,
  routeRegistry,
} from "../../app/registry/routes.js";
import {
  AUTH_META,
  type AuthMeta,
  getMetaTag,
  IDEMPOTENCY_META,
  type IdempotencyMeta,
  PERMISSION_META,
  type PermissionMeta,
  RATE_LIMIT_META,
  type RateLimitMeta,
  SCHEMA_META,
  type SchemaMeta,
} from "../utils/metaTags.js";
import { type RegisterHealthRoutesOptions, registerHealthRoutes } from "./health.js";

/**
 * The framework's standard `Hono.Env` shape — what `c.get(...)` is keyed by.
 * Consumers extend this in their own `AppEnv` type if they want richer
 * variables (e.g., a typed `db` set by an init middleware).
 */
export interface AppEnvVariables {
  requestId?: string;
  /** Authenticated account, set by `requireAuth`. Type is widened to keep the
   *  framework agnostic of the resolved account shape. */
  user?: unknown;
  /** Per-request scoped logger (child of the framework `logger`). */
  logger?: unknown;
}

export interface AppEnv extends Env {
  Variables: AppEnvVariables;
}

export interface CorsOptions {
  /**
   * Allowed origins. Accepts a single origin string, an explicit
   * allowlist, or a per-request resolver that returns the matched
   * origin (or `null`/`undefined` to deny).
   *
   * `"*"` (wildcard) is permitted **only** when `credentials !== true` —
   * the wildcard + credentials combination is rejected by browsers
   * per the CORS spec and is the single most common framework
   * misconfig in production. We throw at config time so the failure
   * mode is "boot error" not "subtle CSRF defense bypass at runtime."
   */
  origin: string | readonly string[] | ((origin: string, c: Context) => string | null | undefined);
  /** Methods allowed on cross-origin requests. */
  allowMethods?: readonly string[];
  /** Request headers permitted via the `Access-Control-Allow-Headers` response. */
  allowHeaders?: readonly string[];
  /** Response headers the browser exposes to client JS. */
  exposeHeaders?: readonly string[];
  /** Preflight cache duration in seconds (`Access-Control-Max-Age`). */
  maxAge?: number;
  /**
   * Whether to allow credentials (cookies, Authorization headers). For
   * cookie-auth flows in this framework — the default — this must be
   * `true` *and* `origin` must be an explicit allowlist (not `"*"`).
   */
  credentials?: boolean;
}

export interface CreateAppOptions {
  /**
   * Inject an alternative registry (tests). Defaults to the framework-wide
   * `routeRegistry` singleton.
   */
  registry?: RouteRegistry;
  /**
   * CORS configuration. When supplied, `hono/cors` is wired as global
   * middleware ahead of any route registration. The framework rejects
   * the wildcard + credentials combination at config time — that
   * pairing is spec-invalid and silently bypasses CSRF defenses if
   * the browser ever honors it (some non-browser HTTP clients do).
   *
   * For a typical multi-tenant SaaS:
   *   `cors: { origin: env.CORS_ORIGINS, credentials: true }`
   * where `CORS_ORIGINS` is an env-driven `https://app.example.com,
   * https://admin.example.com` allowlist.
   */
  cors?: CorsOptions;
  /**
   * Health routes. By default `createApp` mounts unauthenticated
   * `GET /livez` and `GET /readyz` (backed by the framework-wide
   * `healthCheckRegistry`) before anything else is registered, so consumer
   * middleware added afterwards — `requireAuth`, rate limiting, `httpLogger`
   * — never runs for them. They are not added to the route registry.
   *
   * Pass an object to configure them (`prefix`, `readyzTimeoutMs`,
   * `registry` — the same options as `registerHealthRoutes`), or `false` to
   * mount nothing and wire them yourself. Default `{}` (mounted at root,
   * 3-second per-check timeout).
   */
  health?: false | RegisterHealthRoutesOptions;
}

/**
 * `Hono<AppEnv>` factory with route-method interception.
 *
 * Every `app.get/post/put/patch/delete` call is wrapped: the wrapper walks
 * the passed handlers, reads any framework metadata tags, pushes a
 * `RouteEntry` to the registry, then delegates to Hono's real method.
 *
 * User code looks identical to plain Hono — no `defineRoute` ceremony, no
 * decorators, no codegen. The metadata is captured invisibly.
 *
 * Routes registered without `validate` / `requireAuth` are still captured —
 * just schema-less / anonymous, which is *correct*: agents see exactly what's
 * there, including unprotected endpoints (which the `ship-reviewer` agent
 * can flag as convention violations).
 */
export function createApp(opts: CreateAppOptions = {}): Hono<AppEnv> {
  const registry = opts.registry ?? routeRegistry;
  const app = new Hono<AppEnv>();

  if (opts.cors) {
    validateCorsOptions(opts.cors);
    // Hono's cors() accepts the same shape we expose; readonly arrays
    // are narrowed via the cast since hono types want mutable.
    //
    // Unset keys must be OMITTED, never forwarded as explicit `undefined`:
    // hono merges options via spread (`{ ...defaults, ...userOpts }`), so an
    // explicit `undefined` OVERRIDES its default. For allowMethods that
    // meant preflights carried no Access-Control-Allow-Methods header and
    // browsers rejected every non-simple method (DELETE/PUT/PATCH) while
    // GET/POST kept working — invisible until a consumer app's first
    // browser-issued DELETE.
    type HonoCorsOpts = NonNullable<Parameters<typeof cors>[0]>;
    const corsOpts: HonoCorsOpts = {
      origin: opts.cors.origin as HonoCorsOpts["origin"],
    };
    if (opts.cors.allowMethods) corsOpts.allowMethods = Array.from(opts.cors.allowMethods);
    if (opts.cors.allowHeaders) corsOpts.allowHeaders = Array.from(opts.cors.allowHeaders);
    if (opts.cors.exposeHeaders) corsOpts.exposeHeaders = Array.from(opts.cors.exposeHeaders);
    if (opts.cors.maxAge !== undefined) corsOpts.maxAge = opts.cors.maxAge;
    if (opts.cors.credentials !== undefined) corsOpts.credentials = opts.cors.credentials;
    app.use("*", cors(corsOpts));
  }

  // Mounted before route interception (so they stay out of the route
  // registry) and before any consumer middleware (Hono runs handlers in
  // registration order and these respond without calling `next`).
  if (opts.health !== false) {
    registerHealthRoutes(app as unknown as Hono, opts.health ?? {});
  }

  interceptRouteMethods(app, registry);

  return app;
}

export interface CreateModuleAppOptions {
  /** Inject an alternative registry (tests). Defaults to the framework-wide
   *  `routeRegistry` singleton — the same one `createApp` populates. */
  registry?: RouteRegistry;
}

/**
 * `Hono<AppEnv>` factory for a **module sub-app** — the building block of the
 * v4 mount-at-root composition.
 *
 * A module's `defineXxxRoutes(createModuleApp("xxx"), deps)` builds its own
 * bounded route chain on a fresh app, which the consumer mounts onto the root
 * with `root.route("/", buildXxxApp(deps))`. Splitting each module into its
 * own sub-app (rather than chaining every module's routes onto one app) keeps
 * each TypeScript route-type instantiation bounded, so the `hc()` typed client
 * scales to many modules without `tsc` blowing its instantiation budget.
 *
 * Identical to `createApp` except:
 *   - it wires **no CORS** and is not meant to be the server root (global
 *     cross-cutting middleware — `cors`, `httpLogger`, `registerErrorHandlers`
 *     — belong on the root app the sub-app is mounted onto, never here);
 *   - every captured `RouteEntry` is stamped with `module`, lighting up the
 *     Module column in `/dev/routes` and the `module` filter in `list_routes`;
 *   - `app.onError`, `app.notFound`, and global `app.use("*", …)` are
 *     **guarded** — they throw at dev time, because a sub-app error/not-found
 *     handler silently shadows the root's uniform AppError shape and global
 *     sub-app middleware breaks the root-wraps-everything ordering. (Per-route
 *     middleware — `requireAuth`/`requirePermission`/`validate` passed as route
 *     handlers — and **path-scoped** `app.use("/x/*", …)` are still allowed.)
 *
 * Because module sub-apps register their **absolute** paths (`/accounts`,
 * `/accounts/:id`) and are mounted at the root (`route("/", …)`), the registry
 * records the same absolute paths it always has — `execute_route`,
 * `find_route_collisions`, and `/dev/routes` need no prefix math.
 */
export function createModuleApp(
  moduleName: string,
  opts: CreateModuleAppOptions = {},
): Hono<AppEnv> {
  const registry = opts.registry ?? routeRegistry;
  const app = new Hono<AppEnv>();
  interceptRouteMethods(app, registry, moduleName);
  guardCrossCuttingMethods(app, moduleName);
  return app;
}

/**
 * Make a module sub-app fail fast when a developer reaches for a cross-cutting
 * concern that belongs on the root. `onError` / `notFound` / global `use("*")`
 * all "work" on a sub-app but silently break the contract — a sub-app
 * `onError` shadows `registerErrorHandlers`' uniform error shape, and global
 * sub-app middleware doesn't wrap sibling modules. We throw at dev time so the
 * mistake surfaces as a clear error, not a production surprise.
 *
 * Hono reads the stored `errorHandler` / `notFoundHandler` properties at
 * request time (never the public methods), and `.route()` merges a sub-app's
 * pre-built routes without calling these — so overriding the methods only
 * intercepts the developer's call, never Hono's internals.
 */
function guardCrossCuttingMethods(app: Hono<AppEnv>, moduleName: string): void {
  const reject = (method: string, why: string): never => {
    throw new Error(
      `createModuleApp("${moduleName}"): ${method} is not allowed on a module sub-app — ${why} ` +
        `Put it on the root app you mount this sub-app onto (the one from ` +
        `\`createApp(...)\`, mounted via \`root.route("/", build${capitalize(moduleName)}App(deps))\`), not here.`,
    );
  };

  type AnyFn = (...args: unknown[]) => unknown;
  const methods = app as unknown as Record<string, AnyFn>;

  methods.onError = () =>
    reject(
      "app.onError(...)",
      "a sub-app error handler silently shadows the root's uniform AppError JSON shape (registerErrorHandlers).",
    );
  methods.notFound = () =>
    reject("app.notFound(...)", "a sub-app not-found handler shadows the root's 404 handling.");

  const originalUse = app.use.bind(app) as AnyFn;
  methods.use = (...args: unknown[]): unknown => {
    // Global middleware = path-less (`use(mw)`) or wildcard (`use("*", mw)`).
    // That's the cross-cutting footgun; path-scoped `use("/x/*", mw)` is fine.
    const first = args[0];
    if (typeof first !== "string" || first === "*") {
      reject(
        'app.use("*", ...)',
        "cross-cutting middleware (httpLogger/request-context, cors) must wrap every module from the root.",
      );
    }
    return originalUse(...args);
  };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * Wrap `app.get/post/put/patch/delete` so each registration pushes a
 * `RouteEntry` to `registry` before delegating to Hono's real method. When
 * `moduleName` is supplied (sub-apps via `createModuleApp`) the entry is
 * tagged with it. User code looks like plain Hono — the capture is invisible.
 */
function interceptRouteMethods(
  app: Hono<AppEnv>,
  registry: RouteRegistry,
  moduleName?: string,
): void {
  const methods: Array<{ name: "get" | "post" | "put" | "patch" | "delete"; verb: HttpMethod }> = [
    { name: "get", verb: "GET" },
    { name: "post", verb: "POST" },
    { name: "put", verb: "PUT" },
    { name: "patch", verb: "PATCH" },
    { name: "delete", verb: "DELETE" },
  ];

  for (const { name, verb } of methods) {
    const original = app[name].bind(app);
    (app as unknown as Record<string, (path: string, ...h: MiddlewareHandler[]) => Hono<AppEnv>>)[
      name
    ] = (path: string, ...handlers: MiddlewareHandler[]) => {
      const entry = buildRouteEntry(verb, path, handlers);
      if (moduleName !== undefined) entry.module = moduleName;
      registry.add(entry);
      // Hono's overloaded `app.METHOD` accepts varargs of MiddlewareHandler
      // followed by the final handler. Forward as-is.
      return (original as unknown as (...args: unknown[]) => Hono<AppEnv>)(path, ...handlers);
    };
  }
}

/**
 * Reject the `origin: '*'` + `credentials: true` combo at construction
 * time. This combination is invalid per the CORS spec — browsers
 * refuse it — but the framework defends against it explicitly so a
 * misconfigured deployment fails on boot rather than at runtime when
 * a non-compliant HTTP client (or a tool that ignores the response
 * `Access-Control-*` headers) reveals the bypass.
 */
function validateCorsOptions(opts: CorsOptions): void {
  if (opts.credentials !== true) return;

  const origin = opts.origin;
  if (origin === "*") {
    throw new Error(
      "createApp: cors.origin: '*' is incompatible with credentials: true. " +
        "Pass an explicit allowlist (string[] of origins) instead.",
    );
  }
  if (Array.isArray(origin) && origin.length === 1 && origin[0] === "*") {
    throw new Error(
      "createApp: cors.origin: ['*'] is incompatible with credentials: true. " +
        "Pass an explicit allowlist (string[] of origins) instead.",
    );
  }
  if (Array.isArray(origin) && origin.includes("*")) {
    throw new Error(
      "createApp: cors.origin contains '*' alongside other entries, which " +
        "is ambiguous under credentials: true. Pass only explicit origins.",
    );
  }
}

function buildRouteEntry(
  method: HttpMethod,
  path: string,
  handlers: MiddlewareHandler[],
): RouteEntry {
  const entry: RouteEntry = {
    method,
    path,
    auth: { required: false },
    permissions: [],
    schemas: {},
  };

  for (const handler of handlers) {
    const schema = getMetaTag<SchemaMeta>(handler, SCHEMA_META);
    if (schema) entry.schemas[schema.target] = schema.schema;

    const auth = getMetaTag<AuthMeta>(handler, AUTH_META);
    if (auth) {
      entry.auth = {
        required: auth.required,
        provider: auth.providerName,
      };
    }

    const permission = getMetaTag<PermissionMeta>(handler, PERMISSION_META);
    if (permission) {
      // Multiple `requirePermission(...)` middlewares on one route → union.
      for (const slug of permission.permissions) {
        if (!entry.permissions.includes(slug)) entry.permissions.push(slug);
      }
    }

    const rateLimit = getMetaTag<RateLimitMeta>(handler, RATE_LIMIT_META);
    if (rateLimit) {
      entry.rateLimit = {
        windowMs: rateLimit.windowMs,
        max: rateLimit.max,
        scope: rateLimit.scope,
      };
    }

    const idempotency = getMetaTag<IdempotencyMeta>(handler, IDEMPOTENCY_META);
    if (idempotency) entry.idempotent = true;
  }

  return entry;
}
