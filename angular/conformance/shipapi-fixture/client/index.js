const metadata = requestId =>
  Object.freeze({
    headers: Object.freeze({ 'x-request-id': requestId }),
    requestId,
  });

const abortError = () => new globalThis.DOMException('The operation was aborted', 'AbortError');

const delay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(abortError());
      },
      { once: true }
    );
  });

export function createFixtureClient(_options = {}) {
  return Object.freeze({
    async call(operation, input, options = {}) {
      if (operation === 'public.status') {
        await delay(input.query?.delayMs ?? 0, options.signal);
        return {
          ok: true,
          status: 200,
          data: { ready: true },
          requestId: 'request-public-status',
          metadata: metadata('request-public-status'),
        };
      }

      if (options.signal?.aborted) throw abortError();

      if (operation === 'accounts.get') {
        const accountId = input.params.accountId;
        if (accountId === 'missing') {
          return {
            ok: false,
            status: 404,
            error: {
              code: 'ACCOUNT_NOT_FOUND',
              message: 'Account not found',
              requestId: 'request-account-missing',
            },
            requestId: 'request-account-missing',
            metadata: metadata('request-account-missing'),
          };
        }
        return {
          ok: true,
          status: 200,
          data: { id: accountId, ownerId: null },
          requestId: 'request-account-get',
          metadata: metadata('request-account-get'),
        };
      }

      if (operation === 'accounts.create') {
        if (input.body.name.length === 0) {
          return {
            ok: false,
            status: 400,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              details: {
                issues: [{ path: ['body', 'name'], code: 'too_small', message: 'Required' }],
              },
              requestId: 'request-account-invalid',
            },
            requestId: 'request-account-invalid',
            metadata: metadata('request-account-invalid'),
          };
        }
        return {
          ok: true,
          status: 201,
          data: { id: 'account-created', name: input.body.name },
          requestId: 'request-account-create',
          metadata: metadata('request-account-create'),
        };
      }

      if (operation === 'accounts.delete') {
        return {
          ok: true,
          status: 204,
          data: undefined,
          requestId: 'request-account-delete',
          metadata: metadata('request-account-delete'),
        };
      }

      if (operation === 'oauth.callback') {
        // A capable runtime exposes the 3xx; the fixture mirrors ShipAPI's manual-redirect
        // client result: no data, request id, and the Location in the metadata.
        const location = `https://app.example.test/oauth?connected=true&code=${encodeURIComponent(input.query.code)}`;
        return {
          ok: true,
          status: 302,
          data: undefined,
          requestId: 'request-oauth-callback',
          metadata: Object.freeze({
            headers: Object.freeze({ 'x-request-id': 'request-oauth-callback', location }),
            requestId: 'request-oauth-callback',
            location,
          }),
        };
      }

      throw new TypeError(`Fixture client cannot execute ${String(operation)}`);
    },
  });
}
