# `src/app/modules/<%= name %>` — <%= classify(name) %>

## What this module is

<%= description %>

## Public surface

```ts
// src/app/modules/<%= name %>/index.ts
export const <%= camelize(name) %>Routes: Routes;
```

Mount under any path; the module declares its own children:

```ts
// app.routes.ts
{
  path: '',
  children: [
    ...<%= camelize(name) %>Routes,   // → /<%= routePath %>
  ],
}
```

## Dependencies

- `@sixthsummit/ship-angular` (peer)
  <% for (const dep of JSON.parse(dependencies)) { %>
- `src/app/modules/<%= dep %>`
  <% } %>

## Conventions in this module

- Standalone components, OnPush, `inject()` for DI.
- Signal-based reactivity. No `BehaviorSubject` in public exports.
- Typed reactive forms.
- New control flow only (`@if`, `@for`).
- File names match selectors.

These are enforced by the application's Angular compiler and lint rules — `pnpm lint` will surface violations.

## Extension points

- TODO: document the public components / services this module exposes once they exist.

## What this module is NOT

- TODO: be explicit about the boundaries. What scope is this module deliberately out of?
