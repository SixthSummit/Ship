import type {
  ErrorCodeOf,
  HttpOperationId,
  InputOf,
  OperationClient,
  OperationSuccessStatusOf,
} from '@sixthsummit/ship-angular/operations';

type ConformanceResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly headers: { readonly requestId?: string };
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: { readonly code: string };
      readonly headers: { readonly requestId?: string };
    };

type OperationCallExpectation<
  TSuccessStatus extends number = number,
  TErrorCode extends string = string,
> =
  | {
      readonly kind: 'success';
      readonly status: TSuccessStatus;
      readonly requestId?: string;
    }
  | {
      readonly kind: 'failure';
      readonly status: number;
      readonly code: TErrorCode;
      readonly requestId?: string;
    };

type OperationConformanceCall<TContract extends object> = {
  [TId in HttpOperationId<TContract>]: {
    readonly operation: TId;
    readonly input: InputOf<TContract, TId>;
    readonly expect: OperationCallExpectation<
      OperationSuccessStatusOf<TContract, TId>,
      ErrorCodeOf<TContract, TId>
    >;
  };
}[HttpOperationId<TContract>];

type OperationCancellationCall<TContract extends object> = {
  [TId in HttpOperationId<TContract>]: {
    readonly operation: TId;
    readonly input: InputOf<TContract, TId>;
  };
}[HttpOperationId<TContract>];

export interface OperationClientConformanceConfig<TContract extends object> {
  /** Deterministic success and declared-failure calls to verify. */
  readonly calls: ReadonlyArray<OperationConformanceCall<TContract>>;
  /** A call that remains pending long enough for an immediate abort to cancel it. */
  readonly cancellation?: OperationCancellationCall<TContract>;
}

export interface OperationClientConformanceReport {
  readonly calls: number;
  readonly successes: number;
  readonly failures: number;
  readonly cancellation: boolean;
}

/**
 * Verify the runtime invariants shared by generated clients and compatibility adapters.
 *
 * This assertion helper is deliberately test-runner-independent. Consumers run it against the
 * exact packed client artifact they install; a mismatch rejects with a focused diagnostic.
 */
export async function assertOperationClientConformance<TContract extends object>(
  client: OperationClient<TContract>,
  config: OperationClientConformanceConfig<TContract>
): Promise<OperationClientConformanceReport> {
  let successes = 0;
  let failures = 0;

  for (const testCase of config.calls) {
    const result = await callConformanceCase(client, testCase);
    assertCallResult(testCase.operation, result, testCase.expect);
    if (result.ok) successes += 1;
    else failures += 1;
  }

  let cancellation = false;
  if (config.cancellation !== undefined) {
    cancellation = await assertCancellation(client, config.cancellation);
  }

  return Object.freeze({
    calls: config.calls.length,
    successes,
    failures,
    cancellation,
  });
}

function callConformanceCase<TContract extends object>(
  client: OperationClient<TContract>,
  testCase: OperationConformanceCall<TContract>
): Promise<ConformanceResult> {
  return client.call(testCase.operation, testCase.input) as Promise<ConformanceResult>;
}

function assertCallResult(
  operation: string,
  result: ConformanceResult,
  expected: OperationCallExpectation
): void {
  if (result.ok !== (expected.kind === 'success')) {
    throw new Error(
      `Operation client conformance failed for ${operation}: expected ${expected.kind}, received ${result.ok ? 'success' : 'failure'}`
    );
  }
  if (result.status !== expected.status) {
    throw new Error(
      `Operation client conformance failed for ${operation}: expected status ${expected.status}, received ${result.status}`
    );
  }
  if (result.headers.requestId !== expected.requestId) {
    throw new Error(
      `Operation client conformance failed for ${operation}: expected request ID ${String(expected.requestId)}, received ${String(result.headers.requestId)}`
    );
  }
  if (result.ok === false && expected.kind === 'failure') {
    if (result.error.code !== expected.code) {
      throw new Error(
        `Operation client conformance failed for ${operation}: expected error ${expected.code}, received ${result.error.code}`
      );
    }
  }
}

async function assertCancellation<TContract extends object>(
  client: OperationClient<TContract>,
  testCase: OperationCancellationCall<TContract>
): Promise<true> {
  const controller = new AbortController();
  const pending = client.call(testCase.operation, testCase.input, { signal: controller.signal });
  controller.abort();

  try {
    await pending;
  } catch (error: unknown) {
    if (isAbortError(error)) return true;
    throw new Error(
      `Operation client conformance failed for ${testCase.operation}: cancellation rejected with a non-abort error (${errorName(error)})`,
      { cause: error }
    );
  }

  throw new Error(
    `Operation client conformance failed for ${testCase.operation}: cancellation resolved instead of rejecting`
  );
}

function isAbortError(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    (('name' in value &&
      ((value as { readonly name?: unknown }).name === 'AbortError' ||
        (value as { readonly name?: unknown }).name === 'OperationAbortedError')) ||
      ('kind' in value && (value as { readonly kind?: unknown }).kind === 'aborted'))
  );
}

function errorName(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'name' in value) {
    return String((value as { readonly name?: unknown }).name);
  }
  return typeof value;
}
