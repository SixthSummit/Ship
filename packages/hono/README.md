# `@sixthsummit/ship-hono`

Projects compiled Ship operations onto Hono without making Hono part of the
application kernel. The package owns HTTP serialization, credential extraction,
and transport error projection. Application authentication remains an injected
`ActorResolver` from `@sixthsummit/ship-core`.

Request framing and limits are declared with the operation instead of hidden in
middleware:

```ts
transport: http.post("/profile-picture", {
  requestBody: http.body.multipart({
    maxBytes: 6_000_000,
    maxFileBytes: 5_000_000,
    maxFiles: 1,
    maxFields: 2,
    maxFieldBytes: 1_024,
  }),
})
```

`http.body.json()`, `http.body.raw()`, and `http.body.multipart()` project the
same policy into the runtime adapter, client contract, and OpenAPI. The adapter
performs authentication and access checks before reading a protected body and
returns `413` or `415` before the operation handler for limit or media failures.
Multipart file sanitization remains application-owned: inspect the actual bytes,
not the caller's extension or MIME type.

For a migration that must retain an existing JSON error body, configure the
adapter's optional failure projection:

```ts
createHonoAdapter(application, {
  projectFailureBody: ({ error }) => ({
    success: false,
    error: error.message,
    code: error.code,
  }),
  failureContentType: "application/json",
});
```

The callback receives the safe operation failure and an optional operation ID
context for authentication, access,
validation, declared errors, unexpected errors, and unmatched routes. The
adapter keeps the HTTP status and request ID header. `failureContentType` is
optional: use `application/json` only when the existing wire contract requires
that exact header; otherwise failures retain the default
`application/json; charset=UTF-8`. The setting applies to ordinary routes and
webhooks, including a fallback when the projection throws, and does not change
successful responses. Without `projectFailureBody`, the adapter retains the
default `{ success: false, error: { code, message } }` body. A throwing or
unserializable callback falls back to that default body.

An application error can declare response headers when the wire contract needs
them, such as a rate-limit retry interval:

```ts
const bugReportRateLimited = operationError({
  code: "BUG_REPORT_RATE_LIMITED",
  status: 429,
  message: "Try again later",
  headers: ["Retry-After"] as const,
});

// Include bugReportRateLimited in the operation's errors array.
throw operationFailure(bugReportRateLimited, {
  headers: { "Retry-After": "120" },
});
```

The executor and HTTP adapter require exactly the names declared on the
matching error, reject unsafe values, and keep `Content-Type`, `X-Request-Id`,
cookies, and CORS headers framework-owned. Direct execution returns the same
declared headers. The client contract and OpenAPI describe them; the HTTP client
exposes `Retry-After` in `result.metadata.retryAfter`.

An operation that must count authenticated requests before input validation can
register an HTTP-only policy by operation ID. It runs after the actor and access
checks, before the adapter reads or validates query, headers, or body. Construct
the policy and its backend for each app instance when isolation matters:

```ts
createHonoAdapter(application, {
  auth,
  preValidationPolicies: {
    "customers.handle-lookup": async ({ actor }) => {
      const limit = await limiter.check(actor!.id);
      if (!limit.allowed) {
        return {
          allowed: false,
          failure: operationFailure(rateLimited, {
            headers: { "Retry-After": "60" },
          }),
        };
      }
      return { allowed: true, headers: { "RateLimit-Remaining": String(limit.remaining) } };
    },
  },
});
```

Declare `rateLimited` in the operation's `errors` array. Denials with undeclared
errors, invalid policy results, unsafe response headers, and uncaught backend
errors fail closed as safe 500 responses. An allowed policy's headers also
appear on validation failures. Direct executor runs do not invoke HTTP policies;
they preserve operation behavior without a transport request.

For routes that historically validate Hono query objects, use
`queryParsing: "literal-keys"` on the HTTP transport. Repeated keys become an
array, while bracketed names such as `phone[]` remain literal keys. The default
strict mode retains Ship's explicit bracket-array protocol.

Webhook operations from `defineWebhook` bypass credential adapters entirely:
the adapter bounds the exact bytes, runs the bound verifier for every current
secret, constructs the provider actor only after success, and then executes.
Declare `webhooks: { publicBaseUrl, observer? }`; URL-signing verifiers receive
`publicBaseUrl + path` as the canonical URL and never the incoming `Host`.
Responses are stable: `401 WEBHOOK_VERIFICATION_FAILED` without body echo,
stored replay for duplicates, the declared in-flight policy, `503` with
`Retry-After` when the store or secret source is unavailable, and
`500 WEBHOOK_HANDLER_FAILED` without details.

Cached reads carry `x-ship-cache: hit|miss` and the declared `Cache-Control`.
`public, max-age=N` is emitted only when the operation's access is
`publicAccess()`; a `scope: "public"` read behind a permission shares one
entry between callers but projects `private`, so an intermediary never stores
it.

`jobLivenessRoute({ runtime, staleAfterMs?, path? })` serves the job runtime's
per-process liveness (`runtime.liveness()` from `startJobRuntime`) as a health
route: `200` with every job's last start, completion, failure and lag, `503`
once a gated job's lag exceeds `staleAfterMs` (a number for all jobs or a
record per job id), always `cache-control: no-store`. Mount it in the worker
process in place of a hand-written heartbeat.

`httpJobTrigger(job)` projects a `trigger: { kind: "http" }` job onto
`POST /jobs/<id>`; the executor enforces the trigger access and validates the
body against the job input. `bearerTokenCredentials()` and
`jobTriggerActorResolver({ identityTokens, bearerSecrets })` resolve scheduler
identity tokens or scoped bearer secrets into permissionless system actors.
