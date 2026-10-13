import type { OperationClient, OperationResultOf } from '@sixthsummit/ship-angular/operations';
import { describe, expect, it } from 'vitest';
import { assertOperationClientConformance } from './run-operation-client-conformance';

interface Contract {
  readonly 'examples.get': {
    readonly input: { readonly params: { readonly id: string } };
    readonly success: { readonly 200: { readonly id: string } };
    readonly errors: 'NOT_FOUND';
    readonly transport: 'http';
  };
  readonly 'examples.wait': {
    readonly input: { readonly query: { readonly delay: true } };
    readonly success: { readonly 200: { readonly done: true } };
    readonly errors: never;
    readonly transport: 'http';
  };
}

const headers = (requestId: string) => ({ headers: {}, requestId });

function makeClient(
  overrides: {
    readonly badStatus?: boolean;
    readonly ignoreAbort?: boolean;
    readonly nonAbortError?: boolean;
  } = {}
): OperationClient<Contract> {
  return {
    async call(operation, input, options) {
      if (operation === 'examples.wait') {
        if (overrides.ignoreAbort) {
          return {
            ok: true,
            status: 200,
            data: { done: true },
            headers: headers('wait'),
          } as OperationResultOf<Contract, typeof operation>;
        }
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                overrides.nonAbortError
                  ? new Error('network failed')
                  : new DOMException('Aborted', 'AbortError')
              ),
            { once: true }
          );
        });
      }

      const id = (input as { readonly params: { readonly id: string } }).params.id;
      if (id === 'missing') {
        return {
          ok: false,
          status: 404,
          error: { declared: true, code: 'NOT_FOUND', message: 'Not found' },
          headers: headers('missing'),
        } as OperationResultOf<Contract, typeof operation>;
      }
      return {
        ok: true,
        status: overrides.badStatus ? 201 : 200,
        data: { id },
        headers: headers('found'),
      } as OperationResultOf<Contract, typeof operation>;
    },
  };
}

const config = {
  calls: [
    {
      operation: 'examples.get',
      input: { params: { id: 'one' } },
      expect: { kind: 'success', status: 200, requestId: 'found' },
    },
    {
      operation: 'examples.get',
      input: { params: { id: 'missing' } },
      expect: { kind: 'failure', status: 404, code: 'NOT_FOUND', requestId: 'missing' },
    },
  ],
  cancellation: {
    operation: 'examples.wait',
    input: { query: { delay: true } },
  },
} as const;

describe('assertOperationClientConformance', () => {
  it('verifies successes, declared failures, metadata, and aborts', async () => {
    await expect(assertOperationClientConformance(makeClient(), config)).resolves.toEqual({
      calls: 2,
      successes: 1,
      failures: 1,
      cancellation: true,
    });
  });

  it('accepts the normalized ShipAngular cancellation category', async () => {
    const normalized = makeClient();
    const originalCall = normalized.call.bind(normalized);
    normalized.call = ((operation, input, options) =>
      operation === 'examples.wait'
        ? Promise.reject(
            Object.assign(new Error('Operation was aborted'), {
              name: 'OperationAbortedError',
              kind: 'aborted',
            })
          )
        : originalCall(operation, input, options)) as typeof normalized.call;

    await expect(assertOperationClientConformance(normalized, config)).resolves.toMatchObject({
      cancellation: true,
    });
  });

  it('reports a status mismatch with the operation ID', async () => {
    await expect(
      assertOperationClientConformance(makeClient({ badStatus: true }), {
        calls: [config.calls[0]],
      })
    ).rejects.toThrow('examples.get: expected status 200, received 201');
  });

  it('rejects clients that resolve an aborted call', async () => {
    await expect(
      assertOperationClientConformance(makeClient({ ignoreAbort: true }), {
        calls: [],
        cancellation: config.cancellation,
      })
    ).rejects.toThrow('cancellation resolved instead of rejecting');
  });

  it('rejects clients that report cancellation as an unrelated exception', async () => {
    await expect(
      assertOperationClientConformance(makeClient({ nonAbortError: true }), {
        calls: [],
        cancellation: config.cancellation,
      })
    ).rejects.toThrow('cancellation rejected with a non-abort error');
  });

  it('reports mismatched result kinds, request IDs, and error codes', async () => {
    await expect(
      assertOperationClientConformance(makeClient(), {
        calls: [
          {
            ...config.calls[0],
            expect: { kind: 'failure', status: 200, code: 'NOT_FOUND', requestId: 'found' },
          },
        ],
      })
    ).rejects.toThrow('expected failure, received success');

    await expect(
      assertOperationClientConformance(makeClient(), {
        calls: [
          {
            ...config.calls[0],
            expect: { kind: 'success', status: 200, requestId: 'wrong' },
          },
        ],
      })
    ).rejects.toThrow('expected request ID wrong, received found');

    await expect(
      assertOperationClientConformance(makeClient(), {
        calls: [
          {
            ...config.calls[1],
            expect: { kind: 'failure', status: 404, code: 'WRONG', requestId: 'missing' },
          },
        ],
      })
    ).rejects.toThrow('expected error WRONG, received NOT_FOUND');
  });
});
