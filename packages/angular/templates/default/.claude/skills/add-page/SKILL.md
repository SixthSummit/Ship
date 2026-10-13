---
name: add-page
description: Use when the user asks to "add a page", "create a page", "new page component", "scaffold a route", or any request that maps to a new standalone page component in a ShipAngular v4 app. The skill walks the conventions the page must follow (standalone, OnPush, signals, inject(), typed forms, new control flow) and the route registration in the owning module.
---

# Add a new page to a ShipAngular app

A "page" in ShipAngular is a standalone Angular component that lives under `src/app/modules/<module>/pages/<name>/` and is reached by a route in `src/app/modules/<module>/routes.ts`. Pages obey every framework convention enforced by the ESLint custom rules — if you violate one, `pnpm lint` will fail.

## When to use this skill

- The user wants a new top-level view or sub-view in an existing module.
- The user says "add an `about` page", "scaffold a `settings` route", "create a page for `<X>`".
- The user provides a path like `dashboard/reports` and expects a component at that route.

## When NOT to use this skill

- The user wants a brand-new feature **module** (use `add-module` in the framework repo).
- The user wants a child component nested _inside_ an existing page (just write it; pages are the route-mounted shell).
- The user wants a _protected_ route specifically — pair this skill with `add-protected-route`.

## The preferred path: `/ship:add-page`

If the user is open to it, run the slash command — it invokes the `@sixthsummit/ship-angular:page` schematic which guarantees framework-conformant output:

```
/ship:add-page <module> <name>
```

The schematic:

- Creates `src/app/modules/<module>/pages/<name>/<name>.component.ts` with standalone + OnPush + signal-first defaults baked in.
- Appends a lazy `loadComponent` route to `src/app/modules/<module>/routes.ts`.
- Refuses cleanly if the target module doesn't exist (suggest `/ship:add-module <module>` first).

Use the schematic over hand-writing whenever possible.

## When hand-writing is required

If the user wants something the schematic can't produce (unusual route config, embedded child routes, custom imports), hand-write but obey every convention:

1. **File layout**: `src/app/modules/<module>/pages/<name>/<name>.component.ts`. The component class is `<Name>Component`, the selector is `app-<module>-<name>`.
2. **Standalone**: every component is `standalone: true` (the default in Angular 20, but be explicit).
3. **Change detection**: `changeDetection: ChangeDetectionStrategy.OnPush` — non-negotiable.
4. **DI**: `inject(Service)` at field initializer. Never constructor-inject.
5. **State**: `signal<T>(initial)` for local state, `computed(() => ...)` for derived. Never `BehaviorSubject` in component public surface.
6. **Template**: new control flow only — `@if`, `@for` with `track`, `@switch`, `@defer`. No `*ngIf` / `*ngFor`.
7. **Forms**: typed reactive forms — `FormControl<string>({ nonNullable: true, validators: [...] })`. Never `FormControl()` untyped.
8. **Data**: use `createOperationResource()` with the application's typed operation client for ShipAPI. Keep third-party REST separate.

### Minimal page template

```typescript
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { createOperationResource } from '@sixthsummit/ship-angular/operations';
import { injectAppShipClient } from '../../../../../api';

interface Widget {
  id: string;
  name: string;
}

@Component({
  selector: 'app-dashboard-widgets',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (widgets.value(); as list) {
      @for (w of list; track w.id) {
        <p>{{ w.name }}</p>
      } @empty {
        <p>No widgets yet.</p>
      }
    } @else if (widgets.error()) {
      <p>Failed to load. <button (click)="widgets.reload()">Retry</button></p>
    } @else {
      <p>Loading…</p>
    }
  `,
})
export class WidgetsComponent {
  private readonly client = injectAppShipClient();

  readonly widgets = createOperationResource(this.client, 'widgets.list', () => ({ query: {} }));
}
```

### Register the route

Append to `src/app/modules/<module>/routes.ts`:

```typescript
export const dashboardRoutes: Routes = [
  // ...existing
  {
    path: 'widgets',
    loadComponent: () =>
      import('./pages/widgets/widgets.component').then((m) => m.WidgetsComponent),
  },
];
```

Use `loadComponent` (lazy) — never `component` (eager) — so the page isn't pulled into the initial bundle.

## Verification

After the page is created:

1. `pnpm lint` — the ShipAngular ESLint rules (`onpush-required`, `use-inject`, `route-guard-or-public`, `no-rxjs-in-public-api`) all pass.
2. `pnpm type-check` — clean.
3. `pnpm test` — no regressions.
4. Spot-check in the browser: `pnpm start`, navigate to the new route.

If `route-guard-or-public` fires, decide whether the route should be guarded (then use `add-protected-route` to wire `authGuard`) or marked public (`data: { public: true }` on the route).

## Common pitfalls

- **`ChangeDetectionStrategy.Default` left in by mistake** → ESLint fails. Always OnPush.
- **Constructor-injected services** → `use-inject` rule fails. Always `inject()`.
- **`async` pipe in template** → fine, but signals are preferred. If the data layer is signal-based (`ShipResource`, `signal()`), call them directly: `widgets.value()`, not `widgets.value$ | async`.
- **Eager `component:` on the route** → bundle bloat. Always `loadComponent: () => import(...)`.
- **Missing `track` on `@for`** → template compiler error since Angular 17.
