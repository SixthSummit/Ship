import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { inject, type ResourceRef, resource, type Signal, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

/**
 * The reactive resource type returned by {@link createResource}.
 *
 * Same shape regardless of the underlying transport — REST URL/factory
 * (today's signature) or a Hono `hc()` thunk (the additive thunk overload).
 * Components and consumers don't change shape based on the backend.
 */
export interface ShipResource<T> {
  /** The latest value, or `undefined` while loading or on error. */
  readonly value: Signal<T | undefined>;
  /** The current request status. */
  readonly status: Signal<unknown>;
  /** The error from the most recent failed load, or `undefined`. */
  readonly error: Signal<unknown>;
  /** Force a reload (re-fetch). */
  reload(): void;
}

/**
 * Options for the URL/factory call shape of {@link createResource}.
 *
 * Not used by the thunk overload — the thunk owns its own request setup
 * (the user calls `hc()` or `fetch()` inside the function).
 */
export interface CreateResourceOptions<TBody = unknown> {
  /** HTTP method. Default: `'GET'`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Optional body. For non-GET requests. */
  body?: TBody;
  /** Optional additional headers. */
  headers?: Readonly<Record<string, string>>;
  /**
   * Per-resource caching behaviour.
   *
   * - **Default** (omitted / `undefined`): no cache. Each load issues a
   *   request and uses the response body verbatim.
   * - **`{ etag: true }`**: track `ETag` from server responses; on
   *   `reload()`, send `If-None-Match: <etag>`. On a 304 response,
   *   keep the previously held value (no signal change). In-memory
   *   cache keyed by URL — survives `reload()` calls but not service
   *   re-instantiation.
   *
   * Pairs with ShipAPI's `cache` middleware (which emits ETags) and
   * any HTTP backend that respects `If-None-Match`. Invisible to apps
   * that don't opt in — the surface is unchanged.
   */
  cache?: { etag?: boolean };
}

/**
 * Create a reactive resource from an `async () => Promise<T>` thunk.
 *
 * Use this overload to wrap any Promise-returning call — the canonical case
 * is a Hono `hc()` typed-client call against ShipAPI v4 (Phase 7 lock-step
 * shipped in 4.0 GA). Errors thrown from the thunk land on `error`; resolved
 * values land on `value`. The same `{ value, status, error, reload }`
 * surface as the URL overload.
 *
 * The thunk is invoked eagerly on construction to capture its first
 * Promise as the initial load, then re-invoked on each `reload()`. Signal
 * reads inside the thunk are NOT auto-tracked for refetch (use the URL
 * factory overload for that pattern, or trigger `reload()` from an
 * `effect()` that reads the signal).
 *
 * @example Hono RPC against ShipAPI v4
 * ```ts
 * import { api } from '@/api'; // your hc<ShipApiClient>() instance
 * import { createResource, ApiError } from '@sixthsummit/ship-angular';
 *
 * const posts = createResource<Post[]>(async () => {
 *   const res = await api.posts.$get({ query: { limit: '10' } });
 *   if (!res.ok) throw await ApiError.fromResponse(res);
 *   return res.json();
 * });
 * // posts.value() : Signal<Post[] | undefined>
 * ```
 */
export function createResource<T>(thunk: () => Promise<T>): ShipResource<T>;

/**
 * Create a reactive resource bound to an HTTP request.
 *
 * The framework's primary data-fetching primitive. Wraps Angular's
 * `resource()` over `HttpClient` so the auth interceptor and any other
 * registered interceptors apply automatically.
 *
 * Signal reads inside the URL factory ARE tracked — change a signal that
 * the factory reads, and the resource auto-refetches.
 *
 * @example REST against any HTTP backend
 * ```ts
 * const users = createResource<User[]>(
 *   () => `${env.apiBase}/users?limit=${limit()}`,
 *   { method: 'GET' }
 * );
 * ```
 *
 * Must be called inside an injection context (component / service
 * constructor, factory function, `runInInjectionContext`).
 */
export function createResource<T, TBody = unknown>(
  url: string | (() => string),
  options?: CreateResourceOptions<TBody>
): ShipResource<T>;

export function createResource<T, TBody = unknown>(
  source: string | (() => string) | (() => Promise<T>),
  options: CreateResourceOptions<TBody> = {}
): ShipResource<T> {
  // Dispatch URL vs thunk at construction time. URL factories return strings
  // synchronously; thunks return Promises. Probe once: pure URL factories
  // are idempotent and cheap (string concat); thunks return their first
  // Promise which we save and reuse as the initial load.
  if (typeof source === 'string') {
    return urlResource<T, TBody>(source, options);
  }
  const probe = (source as () => string | Promise<T>)();
  if (typeof probe === 'string') {
    return urlResource<T, TBody>(source as () => string, options);
  }
  if (probe && typeof (probe as Promise<T>).then === 'function') {
    return thunkResource<T>(source as () => Promise<T>, probe as Promise<T>);
  }
  throw new Error(
    'createResource: source must be a URL string, a URL factory (() => string), or an async thunk (() => Promise<T>)'
  );
}

function urlResource<T, TBody>(
  url: string | (() => string),
  options: CreateResourceOptions<TBody>
): ShipResource<T> {
  const httpClient = inject(HttpClient);
  const etagEnabled = options.cache?.etag === true;
  const etagCache = new Map<string, { etag: string; value: T }>();

  const ref: ResourceRef<T | undefined> = resource<T | undefined, string>({
    params: () => (typeof url === 'function' ? url() : url),
    loader: async ({ params: u, abortSignal }) => {
      const cached = etagEnabled ? etagCache.get(u) : undefined;
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (cached) headers['If-None-Match'] = cached.etag;

      if (etagEnabled) {
        const obs = httpClient.request<T>(options.method ?? 'GET', u, {
          body: options.body,
          headers,
          observe: 'response',
        });
        let response: HttpResponse<T>;
        try {
          response = (await firstValueFrom(obs)) as HttpResponse<T>;
        } catch (err) {
          // Angular's HttpClient surfaces 304 as an HttpErrorResponse
          // because 304 is outside the 2xx success range. Treat it as a
          // cache hit when we have a cached value to reuse.
          if (err instanceof HttpErrorResponse && err.status === 304 && cached) {
            return cached.value;
          }
          throw err;
        }
        if (abortSignal.aborted) {
          throw new DOMException('createResource: aborted', 'AbortError');
        }
        if (response.status === 304 && cached) {
          return cached.value;
        }
        const fresh = response.body as T;
        const newEtag = response.headers.get('ETag');
        if (newEtag) {
          etagCache.set(u, { etag: newEtag, value: fresh });
        }
        return fresh;
      }

      const obs = httpClient.request<T>(options.method ?? 'GET', u, {
        body: options.body,
        headers,
      });
      const value = await firstValueFrom(obs);
      if (abortSignal.aborted) {
        throw new DOMException('createResource: aborted', 'AbortError');
      }
      return value;
    },
  });
  return {
    value: ref.value,
    status: ref.status,
    error: ref.error,
    reload: () => {
      ref.reload();
    },
  };
}

function thunkResource<T>(thunk: () => Promise<T>, firstPromise: Promise<T>): ShipResource<T> {
  // Counter signal flips on reload(); resource() re-runs the loader when
  // params change. The thunk is invoked again from the loader on subsequent
  // calls — the saved first Promise is consumed exactly once.
  //
  // Mark the eagerly-probed Promise as handled. The loader awaits it via a
  // separate `await` and surfaces rejections through `resource()`'s error
  // signal — but without this no-op catch, the runtime sees an unhandled
  // rejection in the gap between probe and first loader invocation.
  firstPromise.catch(() => {});
  const reloadTrigger = signal(0);
  let savedFirst: Promise<T> | undefined = firstPromise;
  const ref: ResourceRef<T | undefined> = resource<T | undefined, number>({
    params: () => reloadTrigger(),
    loader: async ({ abortSignal }) => {
      const promise = savedFirst ?? thunk();
      savedFirst = undefined;
      const value = await promise;
      if (abortSignal.aborted) {
        throw new DOMException('createResource: aborted', 'AbortError');
      }
      return value;
    },
  });
  return {
    value: ref.value,
    status: ref.status,
    error: ref.error,
    reload: () => {
      reloadTrigger.update(n => n + 1);
    },
  };
}
