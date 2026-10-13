# eval-003-add-page — add a guarded profile page

You are working in a generated ShipAngular application with an app-owned dashboard feature.

Use the page schematic to add `profile` below
`src/app/modules/dashboard/pages/profile`. Mount it at `/profile` behind `authGuard` and
render the current user's email and display name from the `AuthService.user` signal. Cover
authenticated and empty identity states in a colocated `*.test.ts`.

## Success criteria

- The page stays inside the consumer application.
- It is standalone, OnPush, and uses `inject(AuthService)`.
- The route has an explicit guard.
- Tests read signal state rather than subscribing to an observable.
- `pnpm run ci` passes.
