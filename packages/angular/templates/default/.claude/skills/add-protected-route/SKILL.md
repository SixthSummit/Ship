---
name: add-protected-route
description: Use when the user asks to "add a protected route", "guard this route", "require login for X", "make this route require auth", "wrap this with authGuard", or any request that maps to gating a route behind authentication in a ShipAngular v4 app. The skill walks the guard choice (authGuard vs noAuthGuard), where the guard belongs (parent vs leaf), and the redirect/`data` contract.
---

# Add a protected route to a ShipAngular app

Routes are protected with **functional** guards — the framework's ESLint custom rules forbid class-based guards. The two shipped guards are:

- **`authGuard`** — blocks the route until `auth.state()` reports `'authenticated'`. Redirects to the configured login URL otherwise.
- **`noAuthGuard`** — the inverse. Used on `/signin`, `/signup` etc. to bounce already-signed-in users to the dashboard.

Both guards wait for `auth.state()` to leave `'unknown'` before deciding, so they're safe to mount on routes that load before the auth adapter has finished initializing.

## When to use this skill

- The user wants to gate a new or existing route behind authentication.
- The user says "protect /dashboard", "require login for /settings", "redirect signed-in users away from /signin".
- The user is adding a sub-section to an authenticated area.

## When NOT to use this skill

- The user wants role-based or permission-based gating (e.g. "admin only") — `authGuard` is binary. Compose a custom functional guard on top.
- The user wants a _new_ page (use `add-page` first, then this skill to gate it).
- The user wants to gate a _route fragment_ or _outlet content_ — that's component-level rendering, not a guard.

## The preferred path: `/ship:add-protected-route`

If you're creating a new protected page, run the slash command:

```
/ship:add-protected-route <module> <name>
```

It invokes the `@sixthsummit/ship-angular:page` schematic with `--guarded` set, producing a page **and** a route entry wired with `authGuard` + a `loginUrl` data field.

## Hand-wiring an existing route

Open `src/app/modules/<module>/routes.ts` and add `canActivate: [authGuard]` plus the `data.loginUrl` field:

```typescript
import { authGuard, noAuthGuard } from '@sixthsummit/ship-angular';

export const dashboardRoutes: Routes = [
  {
    path: 'dashboard',
    canActivate: [authGuard],
    data: { loginUrl: '/signin' }, // where to send unauthenticated users
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'signin',
    canActivate: [noAuthGuard],
    data: { redirectUrl: '/dashboard' }, // where to send already-signed-in users
    loadComponent: () => import('./pages/signin/signin.component').then((m) => m.SigninComponent),
  },
];
```

## Parent vs leaf placement

Gating at the **parent** route covers every child route automatically — prefer this when the entire section is authenticated:

```typescript
{
  path: 'dashboard',
  canActivate: [authGuard],
  data: { loginUrl: '/signin' },
  loadChildren: () => import('./routes').then(m => m.dashboardChildren),
}
```

Children inherit the guard. Don't re-attach `authGuard` on each child — it just runs again redundantly.

Gating at the **leaf** is correct only when most siblings are public and one specific page is protected.

## The `data` contract

- `data.loginUrl` (required for `authGuard`): the route to redirect unauthenticated users to. Usually `/signin`.
- `data.redirectUrl` (required for `noAuthGuard`): the route to redirect already-signed-in users to. Usually `/dashboard`.
- `data.public: true` (optional): marks a route as intentionally public to silence the `route-guard-or-public` ESLint rule. Use sparingly — it bypasses the safety net.

If you omit `loginUrl` / `redirectUrl`, the guards fall back to the application defaults wired in `app.config.ts`; setting them per-route is the explicit form.

## Verification

1. `pnpm lint` — the `route-guard-or-public` rule confirms every route in the file is either guarded or explicitly marked public.
2. `pnpm type-check` — clean.
3. Smoke in the browser:
   - Sign out, navigate to the protected URL → expect redirect to `loginUrl`.
   - Sign in, navigate to the protected URL → expect the page to render.
   - Signed in, navigate to `/signin` → expect redirect to `redirectUrl`.
4. Spot-check that `auth.state()` is read inside the guards (it is — they're shipped) so the guard waits past `'unknown'`.

## Common pitfalls

- **Class-based guards** (`@Injectable() class AuthGuard implements CanActivate`) — banned. The ESLint rules will fire. Use the functional `authGuard` export.
- **Missing `loginUrl`** — the guard runs but the user is redirected to a default that may not exist in this app. Always set it.
- **Double-gating** parent + child → confusing redirect behavior. Gate once at the highest meaningful level.
- **`canActivate: [authGuard()]`** (with parens) — `authGuard` is the guard itself, not a factory. Pass it directly: `canActivate: [authGuard]`.
- **Guarding `/signin` with `authGuard`** instead of `noAuthGuard` — locks signed-out users out of the sign-in page. The two guards are inverses.
