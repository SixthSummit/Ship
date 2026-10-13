import { RenderMode, type ServerRoute } from '@angular/ssr';

/**
 * Per-route render-mode declarations.
 *
 * The bare template only defines `/` (the welcome page) — that's all
 * this list covers. When you add app-owned feature routes, extend this list to
 * match your route table:
 *
 * - **Prerender** (build-time): marketing pages with no per-user state.
 *   Cheapest, fastest, fully cacheable.
 * - **Server** (per-request SSR): pages that vary by request but don't
 *   need the user's auth state to render.
 * - **Client** (skip SSR): pages that depend on the authenticated user
 *   (the server can't determine auth status without leaking session
 *   into SSR caching).
 *
 * Example after adding public and authenticated application features:
 *
 * ```ts
 * { path: 'home',         renderMode: RenderMode.Prerender },
 * { path: 'signin',       renderMode: RenderMode.Server },
 * { path: 'finishSignIn', renderMode: RenderMode.Server },
 * { path: 'dashboard/**', renderMode: RenderMode.Client },
 * { path: '**',           renderMode: RenderMode.Server },
 * ```
 */
export const serverRoutes: ServerRoute[] = [
  { path: '', renderMode: RenderMode.Prerender },
  { path: '**', renderMode: RenderMode.Server },
];
