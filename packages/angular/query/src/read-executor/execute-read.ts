import {
  createOperationCallScope,
  type HttpOperationId,
  OperationAbortedError,
} from '@sixthsummit/ship-angular/operations';
import { adaptReadResult } from './adapt-read-result';
import type { ExecuteReadOptions } from './execute-read-options';
import type { ShipQueryEnvelope } from './ship-query-envelope';

/** Execute one safe read. QueryClient owns all cache writes and request deduplication. */
export async function executeRead<
  TContract extends object,
  TId extends HttpOperationId<TContract>,
  TScope,
>(options: ExecuteReadOptions<TContract, TId, TScope>): Promise<ShipQueryEnvelope<TContract, TId>> {
  const { client, binding, input, scope, scopePort, previous } = options;
  if (binding.safety !== 'safe')
    throw new TypeError('Query reads require an explicit safe binding');
  const operationId = binding.operationId;
  const call = { ...options.call };
  const headers = { ...call.headers };
  // This adapter owns validators. Caller headers cannot supply a validator for another key.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'if-none-match') delete headers[name];
  }
  const conditional = options.etag !== false;
  if (conditional && previous?.etag !== undefined) headers['if-none-match'] = previous.etag;
  const ensureCurrent = () => {
    if (!scopePort.isCurrent(scope))
      throw new OperationAbortedError('Query scope is no longer current');
  };
  ensureCurrent();
  const request = createOperationCallScope([options.signal, call.signal, scopePort.signal(scope)]);
  try {
    request.throwIfAborted();
    const result = await client.call(operationId, input, {
      ...call,
      headers,
      signal: request.signal,
    });
    request.throwIfAborted();
    ensureCurrent();
    return adaptReadResult<TContract, TId>(result, conditional ? previous : undefined);
  } finally {
    request.cleanup();
  }
}
