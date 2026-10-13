# Operation-backed authentication

ShipAngular separates three concerns that the v4 session adapter previously mixed together:

- `AuthService` owns presentation-facing identity state and capability discovery.
- identity-provider adapters own provider actions such as Firebase password, email-link, popup, and current bearer-token access;
- the operation request policy owns credentials, CSRF, one explicit refresh, and retry safety.

Cookie-session applications use `OperationSessionAuthAdapter` from `@sixthsummit/ship-angular/auth`. The adapter receives a structural `OperationClient` plus typed mappings for `me`, sign-in, registration, sign-out, and refresh operations. It never constructs URLs or starts a network probe in its constructor.

Generate an application-owned binding after installing the packed contract:

```bash
pnpm exec ng generate @sixthsummit/ship-angular:operation-auth app \
  --meOperationId=auth.me \
  --signInOperationId=auth.login \
  --signOutOperationId=auth.logout \
  --refreshOperationId=auth.refresh
```

The generator does not infer identity fields. Its factory requires a `mapUser` decoder supplied
by the application, so malformed or version-skewed identity data cannot become an unchecked cast.

```ts
const session = new OperationSessionAuthAdapter<AppContract>({
  client,
  operations: {
    me: { operation: 'auth.me', input: () => ({}) },
    signIn: {
      operation: 'auth.login',
      input: ({ email, password }) => ({ body: { email, password } }),
    },
    signOut: { operation: 'auth.logout', input: () => ({}) },
    refresh: { operation: 'auth.refresh', input: () => ({}) },
  },
  mapUser: value => UserViewSchema.parse(value),
  getCsrfToken: signal => csrfStore.current(signal),
});

authService.setAdapter(session);
await authService.initialize();
```

The adapter exposes `session.credential`, so the same cookie, CSRF, and refresh suppliers
feed one `OperationRequestPolicy`. Use that object with `createPolicyClientFromPolicy` and
the non-JSON transports. A `401` can trigger one refresh only when the operation policy sets
`refreshAuthentication: true`; ordinary denial is never treated as a general retry.

## Identity honesty

`unauthenticated` means an authoritative identity operation returned `401`, or a confirmed sign-out succeeded. Server failures, inability to reach the API, invalid responses, and provider failures produce `indeterminate` with a safe issue category. If a previously confirmed user existed, that user is retained as `previousUser` without claiming the session is still authenticated.

A failed sign-out does not clear local identity because the HttpOnly server session may still be valid. The action rejects with the complete `OperationApiError`, allowing the UI to report and retry truthfully.

## Browser and SSR lifecycle

Initialization accepts an `AbortSignal`; a superseding probe or `destroy()` aborts active
work and prevents late state publication. The adapter uses no browser globals. SSR client
boundaries and contexts remain request scoped through `provideShipOperationBoundary`, and
only explicitly approved cookies and headers may be forwarded.
