import { fixtureError } from './fixture-client.mjs';

/** Test oracle only. This is deliberately not a production adapter or acceptance bridge. */
export function referenceAdapter(defect) {
  const sharedIdentity = {};
  return async ({ client, scopeKey, requestSignal, requestHeaders = {}, policyRetry = 0 }) => {
    let identity = scopeKey;
    let generation = 0;
    let scope = new globalThis.AbortController();
    const cache = new Map();
    const active = new Map();
    const pages = new Map();
    const mutations = new Set();
    const key = input => JSON.stringify(input);
    const oldViews = new Map();
    const effects = captured => ({
      isCurrent: () => captured === generation,
      run: effect => {
        if (captured !== generation && defect !== 'late-callback') return false;
        effect();
        return true;
      },
    });
    const read = async (input, options = {}) => {
      const captured = generation;
      const cacheKey = key(input);
      if (!options.force && cache.has(cacheKey)) return cache.get(cacheKey);
      if (defect !== 'deduplication' && active.has(cacheKey)) return active.get(cacheKey);
      const signal = globalThis.AbortSignal.any([
        scope.signal,
        ...(requestSignal ? [requestSignal] : []),
        ...(options.signal ? [options.signal] : []),
      ]);
      const promise = (async () => {
        const previous = cache.get(cacheKey);
        const headers = {
          ...requestHeaders,
          ...(previous?.etag ? { 'if-none-match': previous.etag } : {}),
        };
        let result;
        for (let attempt = 0; ; attempt++) {
          result = await abortRace(
            () => client.call('fixture.read', input, { signal, headers }),
            signal
          );
          if (result.status !== 503 || attempt >= policyRetry + (defect === 'retry' ? 1 : 0)) break;
        }
        if (captured !== generation) throw fixtureError('OperationAbortedError');
        if (!result.ok) {
          const error = fixtureError('OperationApiError');
          Object.assign(error, {
            status: result.status,
            code: result.error.code,
            declared: result.error.declared,
            error: defect === 'results' ? { ...result.error } : result.error,
            headers: result.headers,
            details: result.error.details,
            requestId: result.headers.requestId,
          });
          throw error;
        }
        if (result.status === 304 && previous === undefined)
          throw Object.assign(fixtureError('ProtocolError'), {
            kind: 'protocol',
            reason: 'unexpected-status',
          });
        const envelope = {
          data: result.status === 304 ? previous.data : result.data,
          result,
          ...((result.headers.etag ?? previous?.etag)
            ? {
                etag:
                  defect === 'etag' ? result.headers.etag : (result.headers.etag ?? previous?.etag),
              }
            : {}),
        };
        cache.set(cacheKey, envelope);
        return envelope;
      })();
      active.set(cacheKey, promise);
      try {
        return await promise;
      } finally {
        if (active.get(cacheKey) === promise) active.delete(cacheKey);
      }
    };
    return {
      clientIdentity: defect === 'ssr' ? sharedIdentity : {},
      read,
      view(input) {
        const cacheKey = key(input);
        return () => ({
          data: cache.get(cacheKey) ?? (defect === 'scope' ? oldViews.get(cacheKey) : undefined),
          error: null,
        });
      },
      async invalidate(input) {
        if (defect === 'invalidation') cache.clear();
        else cache.delete(key(input));
      },
      async page(input, cursor) {
        const envelope = await read({ ...input, cursor, infinite: true });
        const previous = pages.get(key(input)) ?? { pages: [], pageParams: [] };
        const next = {
          pages: [...previous.pages, envelope],
          pageParams: [...previous.pageParams, defect === 'pagination' ? null : cursor],
        };
        pages.set(key(input), next);
        return next;
      },
      async changeScope(next) {
        identity = next;
        void identity;
        for (const [cacheKey, value] of cache) oldViews.set(cacheKey, value);
        generation++;
        scope.abort();
        scope = new globalThis.AbortController();
        cache.clear();
        active.clear();
        pages.clear();
      },
      mutation(config = {}) {
        let busy = false;
        let stopped = false;
        const controller = new globalThis.AbortController();
        let pending;
        let state = { data: undefined, error: null };
        let observed = generation;
        const mutation = {
          view: () => (observed === generation ? state : { data: undefined, error: null }),
          async execute(input) {
            if (stopped) throw fixtureError('OperationAbortedError');
            if (busy) throw fixtureError('OperationMutationBusyError');
            busy = true;
            observed = generation;
            const captured = generation;
            const guard = effects(captured);
            const signal = globalThis.AbortSignal.any([scope.signal, controller.signal]);
            pending = (async () => {
              let snapshot;
              let applied = false;
              try {
                if (config.optimistic) {
                  snapshot = await config.optimistic.apply(input, guard);
                  applied = true;
                }
                const result = await abortRace(
                  () => client.call('fixture.write', input, { signal }),
                  signal
                );
                if (!result.ok) {
                  const error = fixtureError('OperationApiError');
                  Object.assign(error, {
                    status: result.status,
                    code: result.error.code,
                    declared: result.error.declared,
                    error: result.error,
                    headers: result.headers,
                  });
                  throw error;
                }
                const envelope = { data: result.data, result };
                if (config.onSuccess)
                  await abortRace(() => config.onSuccess(envelope, input, guard), signal);
                state = { data: envelope, error: null };
                return envelope;
              } catch (error) {
                if (applied && captured === generation && defect !== 'rollback')
                  await config.optimistic.rollback(snapshot, error, guard);
                state = { data: undefined, error };
                throw error;
              } finally {
                busy = false;
              }
            })();
            return pending;
          },
          async destroy() {
            stopped = true;
            controller.abort();
            await pending?.catch(() => {});
            mutations.delete(mutation);
          },
        };
        mutations.add(mutation);
        return mutation;
      },
      async destroy() {
        scope.abort();
        await Promise.all([...mutations].map(mutation => mutation.destroy()));
        cache.clear();
      },
    };
  };
}

function abortRace(action, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fixtureError('OperationAbortedError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(action)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
