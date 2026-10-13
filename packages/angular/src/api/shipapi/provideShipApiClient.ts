import { InjectionToken, inject, type Provider, REQUEST } from '@angular/core';

/**
 * Default {@link InjectionToken} for the ShipAPI typed client.
 *
 * Apps can either inject this token directly (with a `as` cast for the
 * concrete return type of their `hc<ShipApiClient>()` call) or pass their
 * own typed token to {@link provideShipApiClient} for full type safety
 * without a cast.
 *
 * The token is intentionally typed `unknown` because the framework does
 * not own the `ShipApiClient` type — that lives in the consumer's API
 * package and is composed from their registered Hono routes.
 */
export const SHIP_API_CLIENT = new InjectionToken<unknown>('SHIP_API_CLIENT');

/**
 * Factory that builds the typed `hc<ShipApiClient>()` instance. Receives
 * the SSR request when available so cookies, request-id forwarding, and
 * other request-scoped concerns can flow into the client.
 *
 * - **Browser**: `req` is `null`. Build the client without request-scoped
 *   headers — cookies are sent automatically when `init.credentials` is
 *   set to `'include'`.
 * - **SSR**: `req` is the incoming `Request`. Forward `req.headers.get('cookie')`
 *   to the upstream API so authenticated SSR renders see the same session
 *   the browser would.
 */
export type ShipApiClientFactory<T> = (req: Request | null) => T;

/**
 * Provide a typed ShipAPI `hc()` client through Angular's dependency
 * injection — request-scoped on the server (via `REQUEST`), singleton on
 * the client.
 *
 * The factory receives the SSR `Request` when one exists; build the client
 * inside the factory so request-scoped concerns flow through. The framework
 * never imports `hc` itself — that comes from `@sixthsummit/ship-api/client`
 * in the consumer's app, which keeps the framework free of a runtime
 * dependency on ShipAPI.
 *
 * @example Default token
 * ```ts
 * import { provideShipApiClient } from '@sixthsummit/ship-angular';
 * import { hc } from '@sixthsummit/ship-api/client';
 * import type { ShipApiClient } from '@my-org/api';
 *
 * provideShipApiClient<ReturnType<typeof hc<ShipApiClient>>>((req) =>
 *   hc<ShipApiClient>(env.apiBase, {
 *     init: {
 *       credentials: 'include',
 *       headers: req ? { cookie: req.headers.get('cookie') ?? '' } : {},
 *     },
 *   })
 * );
 * ```
 *
 * @example Typed app-side token (no inject cast required)
 * ```ts
 * import { InjectionToken } from '@angular/core';
 * import { hc } from '@sixthsummit/ship-api/client';
 * import type { ShipApiClient } from '@my-org/api';
 *
 * type Api = ReturnType<typeof hc<ShipApiClient>>;
 * export const API = new InjectionToken<Api>('API');
 *
 * // In providers:
 * provideShipApiClient<Api>((req) => hc<ShipApiClient>(env.apiBase, ...), API);
 *
 * // In services:
 * private api = inject(API); // typed, no cast
 * ```
 *
 * @param factory - Builds the typed client. Receives `Request | null`.
 * @param token - Optional custom token. Defaults to {@link SHIP_API_CLIENT}.
 */
export function provideShipApiClient<T>(
  factory: ShipApiClientFactory<T>,
  token: InjectionToken<T> = SHIP_API_CLIENT as InjectionToken<T>
): Provider {
  return {
    provide: token,
    useFactory: () => {
      const req = inject(REQUEST, { optional: true });
      return factory(req ?? null);
    },
  };
}

/**
 * Inject the typed ShipAPI client. Convenience wrapper over
 * `inject(SHIP_API_CLIENT) as T` — pass a custom token for full type
 * safety without a cast (matching the token used in {@link provideShipApiClient}).
 *
 * @example
 * ```ts
 * private api = injectShipApiClient<ReturnType<typeof hc<ShipApiClient>>>();
 * ```
 */
export function injectShipApiClient<T = unknown>(
  token: InjectionToken<T> = SHIP_API_CLIENT as InjectionToken<T>
): T {
  return inject(token);
}
