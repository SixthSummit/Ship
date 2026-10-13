/** No timers or services. Tests explicitly release each deferred transport call. */
export function createFixtureClient() {
  const plans = [];
  const calls = [];
  const waiters = [];
  return {
    calls,
    enqueue(result, { held = false, cooperative = true } = {}) {
      let release;
      const gate = held
        ? new Promise(resolve => {
            release = resolve;
          })
        : Promise.resolve();
      plans.push({ result, gate, cooperative });
      return () => release?.();
    },
    started(count) {
      if (calls.length >= count) return Promise.resolve();
      return new Promise(resolve => waiters.push({ count, resolve }));
    },
    async call(operation, input, options = {}) {
      const plan = plans.shift();
      if (!plan) throw new Error(`Unplanned fixture call: ${operation}`);
      const invocation = { operation, input, options };
      calls.push(invocation);
      for (const waiter of waiters) if (calls.length >= waiter.count) waiter.resolve();
      let off = () => {};
      try {
        const aborted = new Promise((_, reject) => {
          const abort = () => reject(fixtureError('OperationAbortedError'));
          if (options.signal?.aborted && plan.cooperative) abort();
          else if (plan.cooperative) {
            options.signal?.addEventListener('abort', abort, { once: true });
            off = () => options.signal?.removeEventListener('abort', abort);
          }
        });
        await Promise.race([plan.gate, aborted]);
        if (plan.result instanceof Error) throw plan.result;
        return typeof plan.result === 'function' ? plan.result(invocation) : plan.result;
      } finally {
        off();
      }
    },
  };
}
export function success(data, status = 200, etag) {
  return { ok: true, status, data, headers: { headers: {}, ...(etag ? { etag } : {}) } };
}
export function notModified(etag) {
  return {
    ok: true,
    status: 304,
    notModified: true,
    headers: { headers: {}, ...(etag ? { etag } : {}) },
  };
}
export function failure(status = 409) {
  return {
    ok: false,
    status,
    error: {
      code: status === 409 ? 'CONFLICT' : 'INVALID',
      message: 'fixture failure',
      declared: true,
    },
    headers: { headers: { 'x-request-id': 'fixture' }, requestId: 'fixture' },
  };
}
export function fixtureError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}
