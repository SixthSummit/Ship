import { fixtureError } from './fixture-client.mjs';

/** Structural HTTP client for browser/SSR wire checks, without any cache or policy behavior. */
export function createHttpFixtureClient(origin) {
  return {
    async call(operation, input, options = {}) {
      const timeout = new globalThis.AbortController();
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => timeout.abort(), options.timeoutMs);
      const signal = globalThis.AbortSignal.any([
        timeout.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        const headers = new globalThis.Headers(options.headers);
        headers.set('content-type', 'application/json');
        const response = await globalThis.fetch(origin, {
          method: 'POST',
          credentials: options.credentials,
          headers,
          body: JSON.stringify({ operation, input }),
          signal,
        });
        const metadata = {
          headers: Object.fromEntries(response.headers),
          ...(response.headers.get('etag') ? { etag: response.headers.get('etag') } : {}),
        };
        if (response.status === 204)
          return { ok: true, status: 204, data: undefined, headers: metadata };
        if (response.status === 304)
          return { ok: true, status: 304, notModified: true, headers: metadata };
        return await response.json();
      } catch (error) {
        if (timeout.signal.aborted) throw fixtureError('OperationTimeoutError');
        if (options.signal?.aborted) throw fixtureError('OperationAbortedError');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
