---
description: Pull all log records for a single request-id from the local pino log file (or stdout if no log file is configured) and surface them in chronological order. Helpful for "why did this 500?" debugging when the request is identifiable by `X-Request-Id` from the response or from a Sentry/error report.
argument-hint: <request-id>
allowed-tools: Bash, Read
---

Filter the local log stream for records carrying `requestId === "$1"`:

```sh
# When pino is writing to a log file (LOG_FILE env or pipe redirect):
grep -F '"requestId":"$1"' "${LOG_FILE:-./logs/app.log}" | npx pino-pretty -t 'SYS:HH:MM:ss.l' || true

# When the process writes to stdout (the default for `ship-api dev`):
# scrollback isn't preserved across runs — re-run the dev server with
# the log captured to a file:
#   LOG_FILE=./logs/app.log npm run dev
# then re-run this command after reproducing.
```

ShipAPI's `httpLogger` middleware sets `requestId` from the `X-Request-Id` header (or generates one) and binds it to the AsyncLocalStorage `RequestContext`. Every `logger.info(...)` / `logger.error(...)` / `logger.warn(...)` call **inside that request** automatically picks up the `requestId` field via pino's child binding — that's how you can grep across the whole request without per-call ceremony.

Things to look for in the chronological output:

1. **Request entry** — `httpLogger`'s "request" record at the start has `method`, `path`, `headers` (redacted), and a `traceId` if OTel is enabled.
2. **Auth result** — `requireAuth`'s log line on success/failure shows `userId` (success) or the `AuthProvider` error (401 with reason).
3. **Permission check** — `requirePermission` logs the permission slug and result.
4. **Validation error** — `validate(...)` throws `ValidationError` with the Zod issue path; the `app.onError` log line shows the issue list.
5. **Domain error** — handler-thrown `AppError` subclasses log with `code` + `statusCode` + `message`; `BadRequestError` / `NotFoundError` / `ConflictError` / etc. surface here.
6. **DB error** — `DrizzleEntityService` errors log with the SQLSTATE code (`23505` = unique violation, `23503` = FK violation, etc.).
7. **Request exit** — `httpLogger`'s "response" record at the end has `statusCode`, `duration`.

If you have OTel enabled (`OTEL_SDK_DISABLED=false`), every log record also carries `trace_id` / `span_id`. Drop the `trace_id` into your tracing UI (Jaeger / Tempo / Honeycomb) for the full waterfall — including DB query timings + downstream HTTP calls — that the log stream alone can't show.

For production debugging:

- **Stackdriver / Cloud Logging**: filter `jsonPayload.requestId="$1"` (gcloud logs the field directly).
- **Datadog**: `@requestId:"$1"`.
- **Loki**: `{job="ship-api"} | json | requestId="$1"`.
- **Honeycomb / Tempo**: search by `trace.trace_id` (which the log record carries) — gives you spans + logs joined.
