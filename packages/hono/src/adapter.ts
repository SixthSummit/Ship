import type { AnyModule, AnyOperation, CompiledApplication } from "@sixthsummit/ship-core";
import {
  type ApplicationExecutor,
  cacheControlHeader,
  checkOperationAccess,
  createExecutor,
  describeWebhookOperation,
  isActorResolver,
  normalizeActorResolution,
  type OperationActor,
  OperationFailure,
  type OperationFailureResult,
  type OperationIdentity,
  type OperationSuccessResult,
  operationActor,
  operationIdentity,
  validateOperationFailureHeaders,
} from "@sixthsummit/ship-core";
import { type Context, Hono } from "hono";
import { type HonoAuthenticationOptions, isHonoCredentialAdapter } from "./auth.js";
import { assertCorsOptions, createCorsMiddleware, type HonoCorsOptions } from "./cors.js";
import { HonoAdapterError } from "./diagnostics.js";
import { executeStreamOperation } from "./stream.js";
import {
  type HttpMultipartBodyPolicy,
  type HttpQueryParsing,
  type HttpRequestBodyPolicy,
  type HttpResponseMode,
  type HttpTransport,
  isHttpStreamTransport,
  isHttpTransport,
} from "./transport.js";
import {
  assertWebhookOptions,
  createWebhookRoute,
  type HonoWebhookOptions,
} from "./webhook-route.js";

const HTTP_INPUT_LOCATIONS = new Set(["params", "query", "headers", "body"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576;
const RESERVED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "keep-alive",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-request-id",
  "x-ship-cache",
]);

export type { HonoAdapterDiagnosticCode } from "./diagnostics.js";
export { HonoAdapterError } from "./diagnostics.js";

export interface ShipHttpErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export interface HonoPreValidationPolicyContext {
  readonly request: Request;
  readonly operationId: string;
  readonly requestId: string;
  readonly actor?: OperationActor;
  readonly identity?: OperationIdentity;
  readonly signal: AbortSignal;
}

export interface HonoFailureProjectionContext {
  readonly operationId?: string;
}

/**
 * A policy allows the request (optionally stamping response headers), denies
 * it with a failure the operation declares, or denies it with one of the
 * ADR-0004 resolution reasons, which the adapter projects exactly as the actor
 * resolver's own refusals (`invalid-credential` → 401 `AUTHENTICATION_ERROR`,
 * `forbidden` → 403 `AUTHORIZATION_ERROR`). The reason form lets a transport
 * guard such as a CSRF check refuse any operation without every operation
 * declaring the error, and without ever surfacing as a 500.
 */
export type HonoPreValidationPolicyResult =
  | Readonly<{ allowed: true; headers?: Readonly<Record<string, string>> }>
  | Readonly<{ allowed: false; failure: OperationFailure }>
  | Readonly<{
      allowed: false;
      reason: "invalid-credential" | "forbidden";
      /** Replaces the framework message in the envelope; never a secret. */
      message?: string;
    }>;

/** Runs after HTTP authentication and access, before input reading or validation. */
export type HonoPreValidationPolicy = (
  context: HonoPreValidationPolicyContext,
) => HonoPreValidationPolicyResult | Promise<HonoPreValidationPolicyResult>;

/**
 * The `preValidationPolicies` key under which a policy runs for every
 * projected operation, ahead of the operation's own policy. Both must allow;
 * their response headers merge, the operation-specific ones winning.
 */
export const GLOBAL_PRE_VALIDATION_POLICY = "*";

// A global symbol, not a module-level map, so a policy named by one copy of
// this package is recognised by another (a consumer that ends up with two
// ship-hono installs still gets the construction-time check).
const POLICY_IDS = Symbol.for("sixthsummit.ship-hono.pre-validation-policy-ids");
const POLICY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

function readPolicyIds(policy: HonoPreValidationPolicy): readonly string[] {
  const ids = Reflect.get(policy, POLICY_IDS);
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : [];
}

function writePolicyIds(policy: HonoPreValidationPolicy, ids: readonly string[]): void {
  Object.defineProperty(policy, POLICY_IDS, { value: Object.freeze([...ids]), enumerable: false });
}

/**
 * Names a pre-validation policy so a credential adapter's
 * {@link HonoPolicyRequirement} can recognise it at construction. The id is
 * the policy's identity, not its configuration: two instances of the same
 * guard carry the same id.
 */
export function definePreValidationPolicy(
  id: string,
  policy: HonoPreValidationPolicy,
): HonoPreValidationPolicy {
  if (typeof id !== "string" || !POLICY_ID_PATTERN.test(id)) {
    throw new TypeError(
      `pre-validation policy id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
    );
  }
  if (typeof policy !== "function") {
    throw new TypeError("pre-validation policy must be a function");
  }
  const named: HonoPreValidationPolicy = (context) => policy(context);
  writePolicyIds(named, [...new Set([...readPolicyIds(policy), id])]);
  return named;
}

/** The ids a policy carries from `definePreValidationPolicy`; a list carries every member's. */
export function preValidationPolicyIds(
  policy: HonoPreValidationPolicy | readonly HonoPreValidationPolicy[] | undefined,
): readonly string[] {
  return [...new Set(policyList(policy).flatMap(readPolicyIds))];
}

function policyList(
  entry: HonoPreValidationPolicy | readonly HonoPreValidationPolicy[] | undefined,
): readonly HonoPreValidationPolicy[] {
  if (entry === undefined) return [];
  return typeof entry === "function" ? [entry] : entry;
}

/**
 * The policies keyed by operation id or `"*"`. A key may hold one policy or
 * a list that runs in order: the first refusal wins and the allow headers
 * accumulate (`Set-Cookie` values are all appended).
 */
export type HonoPreValidationPolicies = Readonly<
  Record<string, HonoPreValidationPolicy | readonly HonoPreValidationPolicy[]>
>;

export interface CreateHonoAdapterOptions<TCredential = unknown> {
  /** Used only when an incoming X-Request-Id is absent or unsafe to reflect. */
  readonly generateRequestId?: () => string;
  /** Explicit credential extraction and transport-independent actor resolution. */
  readonly auth?: HonoAuthenticationOptions<TCredential>;
  /** Maximum decoded JSON request-body size. Defaults to 1 MiB. */
  readonly maxJsonBodyBytes?: number;
  /** Project every safe failure to a consumer-specific JSON body; status and declared-header policy stay framework-owned. */
  readonly projectFailureBody?: (
    failure: Readonly<OperationFailureResult>,
    context: HonoFailureProjectionContext,
  ) => unknown;
  /** JSON failure media type. Omit to retain the framework's charset-qualified default. */
  readonly failureContentType?: "application/json" | "application/json; charset=UTF-8";
  /**
   * Operation-id keyed transport policies; never invoked by direct executor
   * runs. The `"*"` key ({@link GLOBAL_PRE_VALIDATION_POLICY}) runs for every
   * operation before the operation's own policy. A key may hold a list of
   * policies that run in order.
   */
  readonly preValidationPolicies?: HonoPreValidationPolicies;
  /** Receives unexpected failures after the wire response has been made safe. */
  readonly onUnexpectedError?: (
    error: unknown,
    context: HonoUnexpectedErrorContext,
  ) => void | Promise<void>;
  /** Required when the application declares inbound webhooks. */
  readonly webhooks?: HonoWebhookOptions;
  /**
   * Cross-origin policy applied to every projected route, including streaming
   * and webhook routes, and to their preflights. Omit it and the adapter emits
   * no `Access-Control-*` headers. The adapter refuses a wildcard origin
   * combined with `credentials: true` at construction.
   */
  readonly cors?: HonoCorsOptions;
}

export interface HonoUnexpectedErrorContext {
  readonly operationId: string;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
}

/**
 * Projects every HTTP-bound operation onto Hono while leaving execution,
 * validation, access, and provider resolution in the application executor.
 */
export function createHonoAdapter<
  const TApp extends CompiledApplication<string, readonly AnyModule[]>,
  TCredential = unknown,
>(application: TApp, options: CreateHonoAdapterOptions<TCredential> = {}): Hono {
  assertAdapterOptions(options);
  const maxJsonBodyBytes = options.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const projectFailureBody = options.projectFailureBody;
  const failureContentType = options.failureContentType;
  const failureResponse = (failure: OperationFailureResult, operation?: AnyOperation) =>
    serializeFailure(failure, projectFailureBody, operation, failureContentType);
  const routes = collectHttpOperations(application);
  for (const [operationId, policy] of Object.entries(options.preValidationPolicies ?? {})) {
    const known =
      operationId === GLOBAL_PRE_VALIDATION_POLICY ||
      routes.some((operation) => operation.id === operationId);
    const members = typeof policy === "function" ? [policy] : policy;
    if (
      !known ||
      !Array.isArray(members) ||
      members.length === 0 ||
      members.some((member) => typeof member !== "function")
    ) {
      throw new HonoAdapterError(
        "SHIP_HONO_OPTIONS_INVALID",
        `preValidationPolicies contains an unknown operation or invalid policy: ${JSON.stringify(operationId)}`,
      );
    }
  }
  // A credential adapter that reads an ambient credential names the guard it
  // cannot be used without; a missing guard is a construction failure, not a
  // production surprise.
  for (const requirement of options.auth?.credentials.requires ?? []) {
    const registered = options.preValidationPolicies?.[requirement.key];
    if (!preValidationPolicyIds(registered).includes(requirement.policyId)) {
      throw new HonoAdapterError("SHIP_HONO_OPTIONS_INVALID", requirement.message);
    }
  }
  const executor: ApplicationExecutor<CompiledApplication<string, readonly AnyModule[]>> =
    createExecutor(application);
  const app = new Hono();
  // Registered ahead of every route so preflights never reach the 404 handler
  // and operation, streaming and webhook responses all carry the policy.
  if (options.cors !== undefined) app.use("*", createCorsMiddleware(options.cors, routes));

  const webhookRoutes = routes.filter(
    (operation) => describeWebhookOperation(operation)?.role === "receive",
  );
  if (webhookRoutes.length > 0) assertWebhookOptions(options.webhooks);

  for (const operation of routes) {
    const transport = operation.transport;
    if (!isHttpTransport(transport)) continue;

    const role = describeWebhookOperation(operation);
    if (role?.role === "receive" && options.webhooks) {
      app.on(
        transport.metadata.method,
        transport.metadata.path,
        createWebhookRoute(operation, role.webhook, transport, {
          executor,
          webhooks: options.webhooks,
          generateRequestId: options.generateRequestId,
          onUnexpectedError: options.onUnexpectedError,
          projectFailureBody,
          failureContentType,
        }),
      );
      continue;
    }

    app.on(transport.metadata.method, transport.metadata.path, async (context) => {
      const requestId = readRequestId(context, options.generateRequestId);
      const policyHeaders: [string, string][] = [];
      const finish = (response: Response): Response => {
        // A cookie the operation itself set wins over a policy's or the
        // resolver's for the same name: a sign-in that replaces a stale
        // session cookie must not be followed by the clearing instruction.
        const operationCookies = new Set(response.headers.getSetCookie().map(cookieName));
        for (const [name, value] of policyHeaders) {
          if (name.toLowerCase() === "set-cookie") {
            if (!operationCookies.has(cookieName(value))) response.headers.append(name, value);
          } else response.headers.set(name, value);
        }
        return response;
      };
      try {
        const authentication = await resolveActor(context, operation, requestId, options.auth);
        if (authentication.headers) {
          // A resolver may tell the client to drop a dead transport credential
          // (a stale session cookie) whichever way the request goes.
          responseHeaders(requestId, authentication.headers);
          policyHeaders.push(...Object.entries(authentication.headers));
        }
        if (!authentication.ok) return finish(failureResponse(authentication.failure, operation));

        const accessFailure = checkOperationAccess(operation, authentication.actor, requestId);
        if (accessFailure) return failureResponse(accessFailure, operation);

        const policies = [
          options.preValidationPolicies?.[GLOBAL_PRE_VALIDATION_POLICY],
          options.preValidationPolicies?.[operation.id],
        ].flatMap(policyList);
        for (const policy of policies) {
          const decision = await policy({
            request: context.req.raw,
            operationId: operation.id,
            requestId,
            ...(authentication.actor ? { actor: authentication.actor } : {}),
            ...(authentication.identity ? { identity: authentication.identity } : {}),
            signal: context.req.raw.signal,
          });
          if (!decision || typeof decision !== "object" || typeof decision.allowed !== "boolean") {
            throw new TypeError("pre-validation policy must return an allow or deny decision");
          }
          if (!decision.allowed) {
            if ("reason" in decision) {
              return finish(
                failureResponse(resolutionFailure(decision.reason, decision.message, requestId)),
              );
            }
            const { failure } = decision;
            const declared =
              failure instanceof OperationFailure
                ? operation.errors.find(
                    (error) =>
                      error.code === failure.code && error.status === failure.definition.status,
                  )
                : undefined;
            if (!declared) {
              throw new TypeError("pre-validation policy must return a declared operation failure");
            }
            const details = declared.details
              ? await declared.details["~standard"].validate(failure.details)
              : undefined;
            if (details && "issues" in details && details.issues !== undefined) {
              throw new TypeError("pre-validation policy returned invalid failure details");
            }
            return finish(
              failureResponse(
                {
                  ok: false,
                  status: declared.status,
                  error: {
                    code: declared.code,
                    message: failure.message,
                    ...(details && "value" in details ? { details: details.value } : {}),
                  },
                  ...(failure.headers ? { headers: failure.headers } : {}),
                  requestId,
                },
                operation,
              ),
            );
          }
          if (decision.headers) {
            // Reuse the same reserved-name and value validation as operation responses.
            responseHeaders(requestId, decision.headers);
            policyHeaders.push(...Object.entries(decision.headers));
          }
        }

        const input = await readOperationInput(
          context,
          operation,
          transport.metadata.requestBody,
          transport.metadata.queryParsing,
          maxJsonBodyBytes,
        );
        const principal = {
          ...(authentication.actor ? { actor: authentication.actor } : {}),
          ...(authentication.identity ? { identity: authentication.identity } : {}),
        };
        if (isHttpStreamTransport(transport)) {
          return finish(
            await executeStreamOperation({
              declaration: transport.response,
              requestId,
              requestSignal: context.req.raw.signal,
              headers: responseHeaders(requestId),
              run: ({ signal, stream }) =>
                executor.run(operation.id, input, { requestId, signal, stream, ...principal }),
              serializeFailure: (failure) => failureResponse(failure, operation),
              onUnexpectedError: (error) =>
                reportUnexpectedError(options.onUnexpectedError, error, {
                  operationId: operation.id,
                  requestId,
                  method: context.req.method,
                  path: context.req.path,
                }),
            }),
          );
        }
        const result = await executor.run(operation.id, input, {
          requestId,
          signal: context.req.raw.signal,
          ...principal,
        });
        return finish(
          result.ok
            ? serializeSuccess(result, transport, operation)
            : failureResponse(result as OperationFailureResult, operation),
        );
      } catch (error) {
        if (error instanceof HttpRequestError) {
          return finish(failureResponse({ ...error.failure, requestId }));
        }
        if (context.req.raw.signal.aborted) {
          // The client went away mid-flight. The executor already stopped the
          // operation on the same signal; this is not a server defect, so it
          // is not reported to the unexpected-error observer, and the reply
          // is a bodiless 499 that nobody will read.
          return clientAbortedResponse(requestId);
        }
        await reportUnexpectedError(options.onUnexpectedError, error, {
          operationId: operation.id,
          requestId,
          method: context.req.method,
          path: context.req.path,
        });
        return finish(
          failureResponse({
            ok: false,
            status: 500,
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "An unexpected error occurred",
            },
            requestId,
          }),
        );
      }
    });
  }

  app.notFound((context) => {
    const requestId = readRequestId(context, options.generateRequestId);
    return failureResponse({
      ok: false,
      status: 404,
      error: { code: "NOT_FOUND", message: "Route not found" },
      requestId,
    });
  });

  return app;
}

function assertAdapterOptions<TCredential>(options: CreateHonoAdapterOptions<TCredential>): void {
  if (
    options.failureContentType !== undefined &&
    options.failureContentType !== "application/json" &&
    options.failureContentType !== "application/json; charset=UTF-8"
  ) {
    throw new HonoAdapterError(
      "SHIP_HONO_OPTIONS_INVALID",
      "failureContentType must be application/json or application/json; charset=UTF-8",
    );
  }
  const auth = options.auth;
  if (auth !== undefined) {
    if (
      typeof auth !== "object" ||
      auth === null ||
      !isHonoCredentialAdapter(Reflect.get(auth, "credentials")) ||
      !isActorResolver(Reflect.get(auth, "actors"))
    ) {
      throw new HonoAdapterError(
        "SHIP_HONO_AUTH_INVALID",
        "Hono auth must provide a named credential adapter and actor resolver",
      );
    }
  }
  if (
    options.maxJsonBodyBytes !== undefined &&
    (!Number.isSafeInteger(options.maxJsonBodyBytes) || options.maxJsonBodyBytes <= 0)
  ) {
    throw new HonoAdapterError(
      "SHIP_HONO_OPTIONS_INVALID",
      "maxJsonBodyBytes must be a positive safe integer",
    );
  }
  if (options.onUnexpectedError !== undefined && typeof options.onUnexpectedError !== "function") {
    throw new HonoAdapterError("SHIP_HONO_OPTIONS_INVALID", "onUnexpectedError must be a function");
  }
  if (options.cors !== undefined) assertCorsOptions(options.cors);
  if (
    options.projectFailureBody !== undefined &&
    typeof options.projectFailureBody !== "function"
  ) {
    throw new HonoAdapterError(
      "SHIP_HONO_OPTIONS_INVALID",
      "projectFailureBody must be a function",
    );
  }
}

async function resolveActor<TCredential>(
  context: Context,
  operation: AnyOperation,
  requestId: string,
  auth: HonoAuthenticationOptions<TCredential> | undefined,
): Promise<
  | {
      readonly ok: true;
      readonly actor?: OperationActor;
      readonly identity?: OperationIdentity;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly failure: OperationFailureResult;
      readonly headers?: Readonly<Record<string, string>>;
    }
> {
  if (!auth) return { ok: true };
  const credential = await auth.credentials.extract(context.req.raw);
  // Normalise before validating: an actor built on ship-core 1.0 has no `kind`
  // and is a human actor, not an invalid result.
  const resolution = normalizeActorResolution(
    await auth.actors.resolve({
      credential,
      operation: Object.freeze({ id: operation.id, access: operation.access }),
      requestId,
      signal: context.req.raw.signal,
    }),
  );
  if (!resolution) {
    throw new TypeError(
      `actor resolver ${JSON.stringify(auth.actors.id)} returned an invalid result`,
    );
  }
  const headers = resolution.headers ? { headers: resolution.headers } : {};
  if (resolution.ok) {
    return {
      ok: true,
      ...(resolution.actor ? { actor: operationActor(resolution.actor) } : {}),
      ...(resolution.identity ? { identity: operationIdentity(resolution.identity) } : {}),
      ...headers,
    };
  }

  return {
    ok: false,
    failure: resolutionFailure(resolution.reason, undefined, requestId),
    ...headers,
  };
}

/** The name a `Set-Cookie` value sets, for de-duplicating cookies from several sources. */
function cookieName(value: string): string {
  const separator = value.indexOf("=");
  return (separator < 0 ? value : value.slice(0, separator)).trim();
}

/** The ADR-0004 projection of a resolution reason, shared by the resolver path and policy denials. */
function resolutionFailure(
  reason: "invalid-credential" | "forbidden" | "unavailable",
  message: string | undefined,
  requestId: string,
): OperationFailureResult {
  const safeMessage =
    typeof message === "string" && message.length > 0 && message.length <= 256
      ? message
      : undefined;
  if (reason === "invalid-credential") {
    return {
      ok: false,
      status: 401,
      error: { code: "AUTHENTICATION_ERROR", message: safeMessage ?? "Authentication failed" },
      requestId,
    };
  }
  if (reason === "forbidden") {
    return {
      ok: false,
      status: 403,
      error: { code: "AUTHORIZATION_ERROR", message: safeMessage ?? "Access denied" },
      requestId,
    };
  }
  return {
    ok: false,
    status: 503,
    error: { code: "AUTHENTICATION_UNAVAILABLE", message: "Authentication is unavailable" },
    requestId,
  };
}

function collectHttpOperations(
  application: CompiledApplication<string, readonly AnyModule[]>,
): readonly AnyOperation[] {
  const operations: AnyOperation[] = [];
  for (const node of application.graph.operations) {
    if (node.transport?.kind !== "http") continue;
    const operation = Reflect.get(application.operationById, node.id) as AnyOperation;
    const transport = operation.transport;
    if (!isHttpTransport(transport)) {
      throw new HonoAdapterError(
        "SHIP_HONO_TRANSPORT_INVALID",
        `operation ${JSON.stringify(operation.id)} must use http.get/post/put/patch/delete/options`,
        { operationId: operation.id },
      );
    }
    const isWebhook = describeWebhookOperation(operation)?.role === "receive";
    for (const location of Object.keys(operation.input)) {
      // Webhook operations carry the framework-owned `verified` location that
      // the webhook route fills after verification.
      if (isWebhook && location === "verified") continue;
      if (!HTTP_INPUT_LOCATIONS.has(location)) {
        throw new HonoAdapterError(
          "SHIP_HONO_INPUT_LOCATION_UNSUPPORTED",
          `operation ${JSON.stringify(operation.id)} declares unsupported HTTP input location ${JSON.stringify(location)}`,
          { operationId: operation.id, inputLocation: location },
        );
      }
    }
    const pathHasParameters = transport.metadata.path
      .split("/")
      .some((segment) => segment.startsWith(":"));
    const declaresParameters = Object.hasOwn(operation.input, "params");
    if (pathHasParameters !== declaresParameters) {
      throw new HonoAdapterError(
        "SHIP_HONO_PATH_PARAMS_MISMATCH",
        `operation ${JSON.stringify(operation.id)} must declare params input exactly when its HTTP path declares :parameters`,
        { operationId: operation.id, inputLocation: "params" },
      );
    }
    const declaresBody = Object.hasOwn(operation.input, "body");
    const bodyPolicy = transport.metadata.requestBody;
    if (
      (declaresBody &&
        (transport.metadata.method === "GET" || transport.metadata.method === "OPTIONS")) ||
      (!declaresBody &&
        (bodyPolicy.mode !== "json" ||
          bodyPolicy.maxBytes !== undefined ||
          bodyPolicy.onNonJsonContentType !== undefined ||
          bodyPolicy.onInvalidJson !== undefined ||
          bodyPolicy.onEmptyJsonBody !== undefined))
    ) {
      throw new HonoAdapterError(
        "SHIP_HONO_REQUEST_BODY_MISMATCH",
        `operation ${JSON.stringify(operation.id)} request body declaration does not match its HTTP transport policy`,
        { operationId: operation.id, inputLocation: "body" },
      );
    }
    operations.push(operation);
  }
  return Object.freeze(operations);
}

async function readOperationInput(
  context: Context,
  operation: AnyOperation,
  bodyPolicy: HttpRequestBodyPolicy,
  queryParsing: HttpQueryParsing | undefined,
  maxJsonBodyBytes: number,
): Promise<Readonly<Record<string, unknown>>> {
  const input: Record<string, unknown> = {};
  for (const location of Object.keys(operation.input)) {
    switch (location) {
      case "params":
        input.params = context.req.param();
        break;
      case "query":
        input.query = readQuery(context.req.raw.url, queryParsing);
        break;
      case "headers":
        input.headers = readHeaders(context.req.raw.headers);
        break;
      case "body":
        input.body = await readRequestBody(context.req.raw, bodyPolicy, maxJsonBodyBytes);
        break;
    }
  }
  return Object.freeze(input);
}

async function readRequestBody(
  request: Request,
  policy: HttpRequestBodyPolicy,
  defaultMaxJsonBytes: number,
): Promise<unknown> {
  if (policy.mode === "json") {
    return readJsonBody(
      request,
      policy.maxBytes ?? defaultMaxJsonBytes,
      policy.onNonJsonContentType ?? "reject",
      policy.onInvalidJson ?? "reject",
      policy.onEmptyJsonBody ?? "ignore",
    );
  }
  if (policy.mode === "raw") {
    assertAllowedContentType(request.headers.get("content-type"), policy.contentTypes);
    return readBoundedBody(request, policy.maxBytes);
  }
  return readMultipartBody(request, policy);
}

function readQuery(
  url: string,
  parsing: HttpQueryParsing = "strict",
): Readonly<Record<string, string | readonly string[]>> {
  const parsedUrl = new URL(url);
  if (parsing === "first-value") {
    const firstValues = Object.create(null) as Record<string, string>;
    for (const [name, value] of parsedUrl.searchParams) {
      if (!Object.hasOwn(firstValues, name)) firstValues[name] = value;
    }
    return Object.freeze(firstValues);
  }
  if (parsing === "literal-keys") {
    const values = new Map<string, string[]>();
    for (const [name, value] of parsedUrl.searchParams) {
      const entries = values.get(name) ?? [];
      entries.push(value);
      values.set(name, entries);
    }
    const query = Object.create(null) as Record<string, string | readonly string[]>;
    for (const [name, entries] of values) {
      query[name] = entries.length === 1 ? entries[0]! : Object.freeze(entries);
    }
    return Object.freeze(query);
  }
  const rawSearch = parsedUrl.search.slice(1);
  const query = Object.create(null) as Record<string, string | readonly string[]>;
  const valuesByName = new Map<string, string[]>();
  const explicitArrays = new Map<string, string[] | undefined>();

  for (const component of rawSearch ? rawSearch.split("&") : []) {
    const separator = component.indexOf("=");
    const hasValue = separator >= 0;
    const rawName = hasValue ? component.slice(0, separator) : component;
    const rawValue = hasValue ? component.slice(separator + 1) : "";
    const name = decodeQueryComponent(rawName);
    const value = decodeQueryComponent(rawValue);
    if (name.endsWith("[]")) {
      const baseName = name.slice(0, -2);
      if (!baseName || valuesByName.has(baseName)) throw invalidQuery(baseName || name);
      const existing = explicitArrays.get(baseName);
      if (!hasValue) {
        if (explicitArrays.has(baseName)) throw invalidQuery(baseName);
        explicitArrays.set(baseName, undefined);
      } else {
        if (explicitArrays.has(baseName) && existing === undefined) throw invalidQuery(baseName);
        const values = existing ?? [];
        values.push(value);
        explicitArrays.set(baseName, values);
      }
      continue;
    }
    if (explicitArrays.has(name)) throw invalidQuery(name);
    const values = valuesByName.get(name) ?? [];
    values.push(value);
    valuesByName.set(name, values);
  }

  for (const [key, values] of valuesByName) {
    query[key] = values.length === 1 ? values[0] : Object.freeze(values);
  }
  for (const [key, values] of explicitArrays) query[key] = Object.freeze(values ?? []);
  return Object.freeze(query);
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    throw invalidQuery(value);
  }
}

function invalidQuery(name: string): HttpRequestError {
  return new HttpRequestError({
    ok: false,
    status: 400,
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: {
        issues: [
          Object.freeze({
            path: Object.freeze(["query", name]),
            code: "invalid_query_encoding",
            message: "Query array encoding is malformed or ambiguous",
          }),
        ],
      },
    },
  });
}

export function readHeaders(headers: Headers): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries([...headers].map(([name, value]) => [name.toLowerCase(), value])),
  );
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
  onNonJsonContentType: "reject" | "ignore",
  onInvalidJson: "reject" | "ignore",
  onEmptyJsonBody: "reject" | "ignore",
): Promise<unknown> {
  const contentType = request.headers.get("content-type");
  if (request.body && !isJsonContentType(contentType)) {
    // Compatibility routes may have ignored non-JSON bodies entirely. Keep
    // this explicit per-operation: the default continues to reject them.
    if (onNonJsonContentType === "ignore") return undefined;
    throw unsupportedMediaType("Request body must use a JSON content type");
  }
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) {
    if (onEmptyJsonBody === "reject" && isJsonContentType(contentType)) {
      throw invalidJsonBody();
    }
    return undefined;
  }

  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(body) as unknown;
  } catch {
    if (onInvalidJson === "ignore") return undefined;
    throw invalidJsonBody();
  }
}

function invalidJsonBody(): HttpRequestError {
  return new HttpRequestError({
    ok: false,
    status: 400,
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: {
        issues: [
          Object.freeze({
            path: Object.freeze(["body"]),
            code: "invalid_json",
            message: "Request body must contain valid UTF-8 JSON",
          }),
        ],
      },
    },
  });
}

async function readMultipartBody(
  request: Request,
  policy: HttpMultipartBodyPolicy,
): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!isMultipartContentType(contentType)) {
    throw unsupportedMediaType("Request body must use multipart/form-data with a boundary");
  }
  const bytes = await readBoundedBody(request, policy.maxBytes);
  let body: FormData;
  try {
    body = await new Response(bytes as ConstructorParameters<typeof Response>[0], {
      headers: { "content-type": contentType as string },
    }).formData();
  } catch {
    throw invalidMultipart();
  }

  let files = 0;
  let fields = 0;
  const encoder = new TextEncoder();
  for (const [, value] of body) {
    if (typeof value === "string") {
      fields += 1;
      if (fields > policy.maxFields || encoder.encode(value).byteLength > policy.maxFieldBytes) {
        throw multipartLimitExceeded();
      }
      continue;
    }
    files += 1;
    if (files > policy.maxFiles || value.size > policy.maxFileBytes) {
      throw multipartLimitExceeded();
    }
  }
  return body;
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw payloadTooLarge(maxBytes);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw payloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function assertAllowedContentType(
  contentType: string | null,
  allowed: readonly string[],
): void {
  const actual = mediaType(contentType);
  if (!actual || !allowed.includes(actual)) {
    throw unsupportedMediaType(`Request body must use one of: ${allowed.join(", ")}`);
  }
}

function isMultipartContentType(contentType: string | null): boolean {
  return (
    mediaType(contentType) === "multipart/form-data" &&
    /(?:^|;)\s*boundary=(?:"[^"]+"|[^;\s]+)(?:;|$)/iu.test(contentType ?? "")
  );
}

function mediaType(contentType: string | null): string | undefined {
  return contentType?.split(";", 1)[0].trim().toLowerCase() || undefined;
}

/**
 * The wire representation is settled from the declared transport before any
 * operation-supplied header is merged: the declared mode decides whether a
 * body exists and which `Content-Type` it carries. A binary transport may
 * declare several content types and require `respond({ headers })` to select
 * one of them; otherwise `content-type` remains reserved. A `204`/`205`
 * status or the webhook-only `empty` mode has no entity body or content type.
 */
export function serializeSuccess(
  result: OperationSuccessResult,
  transport: HttpTransport,
  operation: AnyOperation,
): Response {
  if (transport.metadata.response === "redirect") {
    const location = result.headers?.location ?? result.headers?.Location;
    if (
      ![301, 302, 303, 307, 308].includes(result.status) ||
      result.data !== undefined ||
      !isSafeRedirectLocation(location)
    ) {
      throw new TypeError("redirect responses require a safe Location and no body");
    }
    return new Response(null, {
      status: result.status,
      headers: responseHeaders(result.requestId, result.headers),
    });
  }
  const representation = declaredRepresentation(transport, result);
  const headers = responseHeaders(
    result.requestId,
    representation.headers,
    representation.contentType,
  );
  applyCacheHeaders(headers, result, operation);
  if (representation.contentType === undefined) {
    return new Response(null, { status: result.status, headers });
  }
  if (transport.metadata.response === "json") {
    return jsonResponse(result.data, result.status, headers, false);
  }
  if (transport.metadata.response === "text") {
    if (typeof result.data !== "string") {
      throw new TypeError("text response data must be a string");
    }
    return new Response(result.data, { status: result.status, headers });
  }
  if (transport.metadata.response === "stream") {
    throw new TypeError("stream responses are serialized by the stream adapter");
  }
  if (!isBinaryBody(result.data)) {
    throw new TypeError("binary response data must be a Blob, ArrayBuffer, byte view, or stream");
  }
  return new Response(result.data as ConstructorParameters<typeof Response>[0], {
    status: result.status,
    headers,
  });
}

function isSafeRedirectLocation(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return false;
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Declared caching is visible on the wire: `x-ship-cache` reports whether the
 * executor served a stored result, and the declared policy projects the
 * `Cache-Control` a client may rely on. `public` is emitted only when the
 * operation's access is public; a permission-gated read with a shared cache
 * key stays `private` so an intermediary never stores it. An operation that
 * sets its own `Cache-Control` through respond() keeps it.
 */
function applyCacheHeaders(
  headers: Headers,
  result: OperationSuccessResult,
  operation: AnyOperation,
): void {
  if (!operation.cache || result.cache === undefined) return;
  headers.set("x-ship-cache", result.cache);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", cacheControlHeader(operation.cache, operation.access));
  }
}

export function serializeFailure(
  result: OperationFailureResult,
  projectFailureBody?: (
    failure: Readonly<OperationFailureResult>,
    context: HonoFailureProjectionContext,
  ) => unknown,
  operation?: AnyOperation,
  failureContentType:
    | "application/json"
    | "application/json; charset=UTF-8" = "application/json; charset=UTF-8",
): Response {
  const envelope: ShipHttpErrorEnvelope = {
    success: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      ...(result.error.details === undefined ? {} : { details: result.error.details }),
    },
  };
  const declaredError = operation?.errors.find(
    (error) => error.code === result.error.code && error.status === result.status,
  );
  if (result.headers && !declaredError) {
    throw new TypeError("failure response headers require a matching declared operation error");
  }
  const failureHeaders = declaredError
    ? validateOperationFailureHeaders(declaredError, result.headers)
    : undefined;
  const headers = responseHeaders(result.requestId, failureHeaders);
  if (projectFailureBody) {
    try {
      return jsonResponse(
        projectFailureBody(result, { operationId: operation?.id }),
        result.status,
        headers,
        failureContentType,
      );
    } catch {
      // A broken consumer projection must not replace a safe operation failure.
    }
  }
  return jsonResponse(envelope, result.status, headers, failureContentType);
}

/**
 * Answer for a request whose client disconnected before the operation
 * finished. `499` is the conventional non-standard status for a client-closed
 * request; the body is empty because no client remains to receive one.
 */
function clientAbortedResponse(requestId: string): Response {
  return new Response(null, { status: 499, headers: responseHeaders(requestId) });
}

function jsonResponse(
  value: unknown,
  status: number,
  headers: Headers,
  contentType: string | false = "application/json; charset=UTF-8",
): Response {
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError("HTTP JSON response body is not serializable");
  if (contentType) headers.set("content-type", contentType);
  return new Response(body, { status, headers });
}

/** The declared `Content-Type` of a successful body, or `undefined` when no body is sent. */
function declaredRepresentation(
  transport: HttpTransport,
  result: OperationSuccessResult,
): { contentType: string | undefined; headers: Readonly<Record<string, string>> | undefined } {
  const mode = transport.metadata.response as HttpResponseMode;
  if (result.status === 204 || result.status === 205 || mode === "empty") {
    return { contentType: undefined, headers: result.headers };
  }
  const choices = transport.metadata.contentTypes;
  if (choices === undefined) {
    return { contentType: transport.metadata.contentType, headers: result.headers };
  }
  const entries = Object.entries(result.headers ?? {});
  const selectors = entries.filter(([name]) => name.toLowerCase() === "content-type");
  if (selectors.length !== 1) {
    throw new TypeError("binary response must select exactly one declared content type");
  }
  const selected = choices.find(
    (choice) => choice.toLowerCase() === selectors[0]![1].toLowerCase(),
  );
  if (selected === undefined) {
    throw new TypeError("binary response selected an undeclared content type");
  }
  return {
    contentType: selected,
    headers: Object.fromEntries(entries.filter(([name]) => name.toLowerCase() !== "content-type")),
  };
}

function responseHeaders(
  requestId: string,
  operationHeaders: Readonly<Record<string, string>> | undefined = undefined,
  contentType: string | undefined = undefined,
): Headers {
  const headers = new Headers({ "x-request-id": requestId });
  if (contentType !== undefined) headers.set("content-type", contentType);
  for (const [name, value] of Object.entries(operationHeaders ?? {})) {
    const lower = name.toLowerCase();
    // CORS headers are the adapter's: an operation cannot widen the policy.
    if (RESERVED_RESPONSE_HEADERS.has(lower) || lower.startsWith("access-control-")) {
      throw new TypeError(
        `operation may not override reserved response header ${JSON.stringify(name)}`,
      );
    }
    // `Set-Cookie` is the one header that must stay one-per-cookie: an operation
    // and a policy may each set one without clobbering the other.
    if (lower === "set-cookie") headers.append(name, value);
    else headers.set(name, value);
  }
  return headers;
}

function isJsonContentType(contentType: string | null): boolean {
  const type = mediaType(contentType);
  return (
    type === "application/json" ||
    Boolean(type?.startsWith("application/") && type.endsWith("+json"))
  );
}

function unsupportedMediaType(message: string): HttpRequestError {
  return new HttpRequestError({
    ok: false,
    status: 415,
    error: { code: "UNSUPPORTED_MEDIA_TYPE", message },
  });
}

function multipartLimitExceeded(): HttpRequestError {
  return new HttpRequestError({
    ok: false,
    status: 413,
    error: {
      code: "PAYLOAD_TOO_LARGE",
      message: "Multipart body exceeds its declared file or field limits",
    },
  });
}

function invalidMultipart(): HttpRequestError {
  return new HttpRequestError({
    ok: false,
    status: 400,
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: {
        issues: [
          Object.freeze({
            path: Object.freeze(["body"]),
            code: "invalid_multipart",
            message: "Request body must contain valid multipart form data",
          }),
        ],
      },
    },
  });
}

function isBinaryBody(value: unknown): boolean {
  return (
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof ReadableStream
  );
}

function payloadTooLarge(maxBytes: number): HttpRequestError {
  return new HttpRequestError({
    ok: false,
    status: 413,
    error: {
      code: "PAYLOAD_TOO_LARGE",
      message: `Request body exceeds the ${maxBytes}-byte limit`,
    },
  });
}

export async function reportUnexpectedError(
  observer: CreateHonoAdapterOptions["onUnexpectedError"],
  error: unknown,
  context: HonoUnexpectedErrorContext,
): Promise<void> {
  try {
    await observer?.(error, Object.freeze(context));
  } catch {
    // Observability cannot replace or leak through the safe wire response.
  }
}

export function readRequestId(
  context: Context,
  generateRequestId: (() => string) | undefined,
): string {
  const incoming = context.req.raw.headers.get("x-request-id")?.trim();
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  let generated: unknown;
  try {
    generated = generateRequestId?.();
  } catch {
    generated = undefined;
  }
  return typeof generated === "string" && REQUEST_ID_PATTERN.test(generated)
    ? generated
    : globalThis.crypto.randomUUID();
}

export class HttpRequestError extends Error {
  readonly failure: Omit<OperationFailureResult, "requestId">;

  constructor(failure: Omit<OperationFailureResult, "requestId">) {
    super("HTTP request input is invalid");
    this.name = "HttpRequestError";
    this.failure = Object.freeze(failure);
  }
}
