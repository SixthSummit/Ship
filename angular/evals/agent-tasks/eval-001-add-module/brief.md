# eval-001-add-module — add an app-owned feedback feature

You are working in a generated ShipAngular application with a packed contract exposing
`feedback.create`.

Create `src/app/modules/feedback` with the module and page schematics. The `/feedback`
route must use `authGuard`. Build a typed reactive form with one `message` control and
submit through `createOperationMutation` plus the application's typed client. Preserve the
failed `OperationResult` so the UI can render declared validation errors without parsing a
message. Add deterministic Vitest coverage in a colocated `*.test.ts` file.

Do not add framework-root modules, raw URLs, `fetch`, `HttpClient`, or server imports.

## Success criteria

- The feature is entirely under `src/app/modules/feedback`.
- Its route is guarded and its component is standalone, OnPush, signal-first, and typed.
- Submission uses stable operation ID `feedback.create` through `createOperationMutation`.
- The test covers success and a declared failure value.
- `pnpm run ci` passes.
