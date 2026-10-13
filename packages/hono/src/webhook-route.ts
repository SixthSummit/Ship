import type {
  AnyModule,
  AnyOperation,
  AnyWebhook,
  ApplicationExecutor,
  CompiledApplication,
  OperationFailureResult,
  WebhookObserver,
  WebhookReceiptOutcome,
  WebhookVerification,
} from "@sixthsummit/ship-core";
import {
  bytesToHex,
  digest,
  isWebhookVerification,
  OperationExecutionError,
  providerActor,
} from "@sixthsummit/ship-core";
import type { Context } from "hono";
import {
  assertAllowedContentType,
  HonoAdapterError,
  HttpRequestError,
  readBoundedBody,
  readHeaders,
  readRequestId,
  reportUnexpectedError,
  serializeFailure,
  serializeSuccess,
} from "./adapter.js";
import type { HttpTransport } from "./transport.js";

const DEFAULT_WAIT_POLL_MS = 25;
const MAX_WAIT_POLL_MS = 500;
const RETRY_AFTER_SECONDS = "1";
/** Executor diagnostics that mean "the durable store could not record this delivery". */
const UNAVAILABLE_CODES = new Set([
  "SHIP_OPERATION_IDEMPOTENCY_STORE_UNAVAILABLE",
  "SHIP_PROVIDER_INITIALIZATION_FAILED",
  "SHIP_OPERATION_TRANSACTION_FAILED",
  "SHIP_OPERATION_UNIT_OF_WORK_INVALID",
]);

export interface HonoWebhookOptions {
  /**
   * The externally visible origin (and optional path prefix) providers were
   * given, for example `https://api.example.com`. The canonical URL handed to
   * verifiers is this value plus the operation path; the incoming `Host` and
   * `X-Forwarded-*` headers are never consulted.
   */
  readonly publicBaseUrl: string;
  readonly observer?: WebhookObserver;
  /** Injectable clock for deterministic freshness tests. */
  readonly clock?: () => Date;
  /** Initial poll interval for `inFlight: { kind: "wait" }`; doubles up to 500 ms. */
  readonly waitPollMs?: number;
}

export interface WebhookRouteDependencies {
  readonly executor: ApplicationExecutor<CompiledApplication<string, readonly AnyModule[]>>;
  readonly webhooks: HonoWebhookOptions;
  readonly generateRequestId?: () => string;
  readonly projectFailureBody?: (
    failure: Readonly<OperationFailureResult>,
    context: { readonly operationId?: string },
  ) => unknown;
  readonly failureContentType?: "application/json" | "application/json; charset=UTF-8";
  readonly onUnexpectedError?: (
    error: unknown,
    context: { operationId: string; requestId: string; method: string; path: string },
  ) => void | Promise<void>;
}

export function assertWebhookOptions(options: unknown): asserts options is HonoWebhookOptions {
  const baseUrl =
    typeof options === "object" && options !== null
      ? Reflect.get(options, "publicBaseUrl")
      : undefined;
  if (typeof baseUrl !== "string" || !isPublicBaseUrl(baseUrl)) {
    throw new HonoAdapterError(
      "SHIP_HONO_WEBHOOK_BASE_URL_REQUIRED",
      "webhooks.publicBaseUrl must be an absolute http(s) URL without query or fragment; verifiers derive the canonical URL from it, never from the incoming request",
    );
  }
  const observer = Reflect.get(options as object, "observer");
  const clock = Reflect.get(options as object, "clock");
  const waitPollMs = Reflect.get(options as object, "waitPollMs");
  if (
    (observer !== undefined && (typeof observer !== "object" || observer === null)) ||
    (clock !== undefined && typeof clock !== "function") ||
    (waitPollMs !== undefined && (!Number.isSafeInteger(waitPollMs) || waitPollMs <= 0))
  ) {
    throw new HonoAdapterError(
      "SHIP_HONO_OPTIONS_INVALID",
      "webhooks.observer must be an object, webhooks.clock a function and webhooks.waitPollMs a positive integer",
    );
  }
}

export function canonicalWebhookUrl(publicBaseUrl: string, path: string): string {
  const base = new URL(publicBaseUrl);
  const prefix = base.pathname.replace(/\/+$/u, "");
  return `${base.origin}${prefix}${path}`;
}

/**
 * The webhook receive pipeline: bound raw body -> verifier -> provider actor
 * -> executor (access, idempotency claim, handler or durable receipt).
 * Credential adapters and actor resolvers never run for webhook routes; the
 * verifier is the only authentication step and the provider actor exists only
 * after it succeeds.
 */
export function createWebhookRoute(
  operation: AnyOperation,
  webhook: AnyWebhook,
  transport: HttpTransport,
  dependencies: WebhookRouteDependencies,
): (context: Context) => Promise<Response> {
  const { executor, webhooks } = dependencies;
  const clock = webhooks.clock ?? (() => new Date());
  const canonicalUrl = canonicalWebhookUrl(webhooks.publicBaseUrl, transport.metadata.path);
  const policy = transport.metadata.requestBody;
  const providerId = webhook.provider.provider;
  const inFlight = webhook.idempotency.inFlight;
  const initialPoll = webhooks.waitPollMs ?? DEFAULT_WAIT_POLL_MS;
  const failureResponse = (failure: OperationFailureResult, declared?: AnyOperation) =>
    serializeFailure(
      failure,
      dependencies.projectFailureBody,
      declared,
      dependencies.failureContentType,
    );

  return async (context) => {
    const startedAt = Date.now();
    const requestId = readRequestId(context, dependencies.generateRequestId);
    const observe = (outcome: WebhookReceiptOutcome, status: number, reason?: string) => {
      try {
        webhooks.observer?.received?.({
          webhookId: webhook.id,
          provider: providerId,
          outcome,
          status,
          ...(reason ? { reason } : {}),
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Observability never changes the wire response.
      }
    };
    const unavailable = (code: string, message: string, reason: string): Response => {
      observe("unavailable", 503, reason);
      return withRetryAfter(
        failureResponse({ ok: false, status: 503, error: { code, message }, requestId }),
      );
    };

    try {
      if (policy.mode !== "raw") {
        throw new TypeError(`webhook ${JSON.stringify(operation.id)} must declare a raw body`);
      }
      assertAllowedContentType(context.req.raw.headers.get("content-type"), policy.contentTypes);
      const rawBody = await readBoundedBody(context.req.raw, policy.maxBytes);
      const headers = readHeaders(context.req.raw.headers);

      let secrets: readonly string[];
      try {
        secrets = await webhook.provider.secret.current();
      } catch (error) {
        await reportUnexpectedError(dependencies.onUnexpectedError, error, errorContext());
        return unavailable(
          "WEBHOOK_SECRET_UNAVAILABLE",
          "Webhook verification is temporarily unavailable",
          "secret-unavailable",
        );
      }
      if (
        !Array.isArray(secrets) ||
        secrets.length === 0 ||
        secrets.some((secret) => typeof secret !== "string" || secret.length === 0)
      ) {
        return unavailable(
          "WEBHOOK_SECRET_UNAVAILABLE",
          "Webhook verification is temporarily unavailable",
          "secret-unavailable",
        );
      }

      const now = clock();
      let verified: Extract<WebhookVerification, { readonly ok: true }> | undefined;
      let failureReason = "signature-mismatch";
      for (const secret of secrets) {
        const result = await webhook.provider.verifier.verify({
          headers,
          rawBody,
          method: "POST",
          canonicalUrl,
          secret,
          now,
        });
        if (!isWebhookVerification(result)) {
          throw new TypeError(
            `webhook verifier ${JSON.stringify(webhook.provider.verifier.id)} returned an invalid result`,
          );
        }
        if (result.ok) {
          verified = result;
          break;
        }
        failureReason = result.reason;
      }
      if (!verified) {
        observe("rejected", 401, failureReason);
        return failureResponse({
          ok: false,
          status: 401,
          error: { code: "WEBHOOK_VERIFICATION_FAILED", message: "Webhook verification failed" },
          requestId,
        });
      }

      const actor = providerActor({
        id: `${providerId}:${verified.eventId ?? requestId}`,
        provider: providerId,
      });
      const input = Object.freeze({
        headers,
        body: rawBody,
        verified: Object.freeze({
          ...(verified.eventId ? { eventId: verified.eventId } : {}),
          ...(verified.timestamp ? { timestamp: verified.timestamp.toISOString() } : {}),
          bodyDigest: bytesToHex(await digest("SHA-256", rawBody)),
        }),
      });

      const deadline = inFlight.kind === "wait" ? Date.now() + inFlight.maxMs : undefined;
      let poll = initialPoll;
      while (true) {
        const result = await executor.run(operation.id, input, {
          requestId,
          signal: context.req.raw.signal,
          actor,
        });
        if (result.ok) {
          observe(result.replayed ? "duplicate" : "accepted", result.status);
          return serializeSuccess(result, transport, operation);
        }
        const failure = result as OperationFailureResult;
        if (failure.error.code !== "IDEMPOTENT_IN_FLIGHT") {
          observe("failed", failure.status, failure.error.code);
          return failureResponse(failure, operation);
        }
        if (deadline !== undefined && Date.now() + poll <= deadline) {
          await sleep(poll);
          poll = Math.min(poll * 2, MAX_WAIT_POLL_MS);
          continue;
        }
        const status = inFlight.kind === "retry" ? inFlight.status : 503;
        observe("in-flight", status, "in-flight");
        return withRetryAfter(
          failureResponse({
            ok: false,
            status,
            error: {
              code: "WEBHOOK_IN_FLIGHT",
              message: "An identical delivery is still being processed",
            },
            requestId,
          }),
        );
      }
    } catch (error) {
      if (error instanceof HttpRequestError) {
        observe("rejected", error.failure.status, error.failure.error.code);
        return failureResponse({ ...error.failure, requestId });
      }
      await reportUnexpectedError(dependencies.onUnexpectedError, error, errorContext());
      if (error instanceof OperationExecutionError && UNAVAILABLE_CODES.has(error.code)) {
        return unavailable(
          "WEBHOOK_UNAVAILABLE",
          "Webhook receipt is temporarily unavailable",
          error.code,
        );
      }
      const handlerFailed =
        error instanceof OperationExecutionError && error.code === "SHIP_OPERATION_HANDLER_FAILED";
      observe("failed", 500, error instanceof OperationExecutionError ? error.code : "unexpected");
      return failureResponse({
        ok: false,
        status: 500,
        error: handlerFailed
          ? { code: "WEBHOOK_HANDLER_FAILED", message: "Webhook processing failed" }
          : { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" },
        requestId,
      });
    }

    function errorContext() {
      return {
        operationId: operation.id,
        requestId,
        method: context.req.method,
        path: context.req.path,
      };
    }
  };
}

function withRetryAfter(response: Response): Response {
  response.headers.set("retry-after", RETRY_AFTER_SECONDS);
  return response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPublicBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}
