# eval-006-websocket-subscription — add a typed notifications socket

You are working in a generated ShipAngular application with packed artifacts for socket
operation `notifications.subscribe`. The binding declares protocol names, message codecs,
close codes, reconnect policy, and an optional short-lived ticket operation.

Add a root-provided `NotificationsService` using `createOperationSocket`, the application
client, and the generated binding. Expose typed message/status signals, connect explicitly,
bound retained history and queued sends, and remain inert under SSR. Authentication must be
re-evaluated through the declared ticket/reconnect flow; do not put bearer credentials in a
URL or invent protocol constants. Add deterministic tests for protocol mismatch, reconnect,
and SSR unavailability.

## Success criteria

- Stable operation ID `notifications.subscribe` and its generated binding drive the socket.
- Messages, connection status, close information, ticket failure, and errors are observable.
- Allowed socket origins and bounded buffers are explicit.
- Tests prove reconnect obtains fresh authorization and SSR touches no browser global.
- `pnpm run ci` passes.
