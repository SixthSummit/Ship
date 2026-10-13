# eval-007-file-upload — build a typed avatar operation upload

You are working in a generated ShipAngular application with packed artifacts for upload
operation `accounts.avatar.upload`. Its generated binding owns field name, media types,
count/size limits, serialization, declared errors, and response decoding.

Generate an avatar component and use `createOperationUpload` with the application request
policy and generated binding. Show binding-derived accepted media types, progress, Cancel,
declared rejection, exceptional failure, and success. The selected file must be assembled
as typed operation input. Add deterministic tests for client constraint rejection, auth/CSRF
policy application, progress, cancellation, and a server-declared failure.

Do not construct a multipart request, authorization header, or XHR in application code.

## Success criteria

- Stable operation ID `accounts.avatar.upload` selects typed input/result.
- The component uses binding constraints and shared request policy.
- Progress and cancellation are signal-driven.
- Declared failures remain values and exceptional failures remain errors.
- `pnpm run ci` passes.
