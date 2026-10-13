import type { SystemOperationActor } from "./actor.js";
import { systemActor } from "./actor.js";
import type { CompiledApplication } from "./application.js";
import type { ApplicationExecutor } from "./executor.js";
import { OperationExecutionError } from "./executor.js";
import type { AnyModule } from "./module.js";
import type { OutboxBackoff, OutboxDispatchResult } from "./outbox.js";
import { backoffDelay } from "./outbox.js";

/** System actor the framework runners dispatch as when the caller names none. */
export const OUTBOX_RUNNER_ACTOR_ID = "ship.outbox.dispatcher";

export type OutboxRunnerErrorCode = "SHIP_OUTBOX_RUNNER_INVALID" | "SHIP_OUTBOX_DISPATCH_FAILED";

export class OutboxRunnerError extends Error {
  readonly code: OutboxRunnerErrorCode;
  readonly operationId?: string;

  constructor(
    code: OutboxRunnerErrorCode,
    message: string,
    options: { readonly operationId?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OutboxRunnerError";
    this.code = code;
    if (options.operationId !== undefined) this.operationId = options.operationId;
  }
}

type AnyExecutor = ApplicationExecutor<CompiledApplication<string, readonly AnyModule[]>>;

export interface DispatchOutboxOptions {
  /** Defaults to `systemActor({ id: OUTBOX_RUNNER_ACTOR_ID })`. */
  readonly actor?: SystemOperationActor;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

/**
 * Performs one dispatch pass of the named `<outbox>.dispatch` operation
 * through the executor and returns what it claimed, completed, retried and
 * dead-lettered against its batch size. A run that does not succeed (the
 * operation is not composed, the backend refused) is
 * `SHIP_OUTBOX_DISPATCH_FAILED`.
 */
export async function dispatchOutbox(
  executor: AnyExecutor,
  operationId: string,
  options: DispatchOutboxOptions = {},
): Promise<OutboxDispatchResult> {
  let result: Awaited<ReturnType<AnyExecutor["run"]>>;
  try {
    result = await executor.run(operationId as never, {} as never, {
      actor: options.actor ?? systemActor({ id: OUTBOX_RUNNER_ACTOR_ID }),
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof OperationExecutionError)) throw error;
    throw new OutboxRunnerError(
      "SHIP_OUTBOX_DISPATCH_FAILED",
      error.code === "SHIP_OPERATION_NOT_FOUND"
        ? `outbox dispatcher ${JSON.stringify(operationId)} is not composed into the application; add the operations from defineOutboxDispatcher() to a module`
        : `outbox dispatcher ${JSON.stringify(operationId)} failed with ${error.code}`,
      { operationId, cause: error },
    );
  }
  if (!result.ok) {
    throw new OutboxRunnerError(
      "SHIP_OUTBOX_DISPATCH_FAILED",
      `outbox dispatcher ${JSON.stringify(operationId)} failed with ${result.error.code}: ${result.error.message}`,
      { operationId },
    );
  }
  return result.data as OutboxDispatchResult;
}

/** What one runner pass did; handed to the observer for metrics. */
export type OutboxDispatchRunnerPass =
  | { readonly ok: true; readonly result: OutboxDispatchResult; readonly durationMs: number }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly durationMs: number;
      /** Consecutive failed passes including this one. */
      readonly failures: number;
      /** How long the runner backs off before the next pass. */
      readonly retryInMs: number;
    };

/** Instrumentation seam; adapters provide OpenTelemetry implementations. */
export interface OutboxDispatchRunnerObserver {
  pass(pass: OutboxDispatchRunnerPass): void;
}

export interface OutboxDispatchRunnerOptions extends DispatchOutboxOptions {
  /**
   * Wait after a pass that came back short or empty (fewer records than the
   * dispatcher's batch size). Defaults to 1,000 ms.
   */
  readonly intervalMs?: number;
  /**
   * A full pass (`claimed === batchSize`) is followed by another at once,
   * because more records are probably due. At most this many full passes run
   * back to back before the runner yields to `intervalMs`, so one process
   * cannot spend every tick draining a backlog. Defaults to 10. Sustained
   * capacity is therefore about `batchSize x maxPassesPerCycle` per
   * `intervalMs + maxPassesPerCycle x pass duration`.
   */
  readonly maxPassesPerCycle?: number;
  /** Wait after a failed pass, growing per consecutive failure. Defaults to 250 ms doubling up to 30 s. */
  readonly backoff?: OutboxBackoff;
  readonly observer?: OutboxDispatchRunnerObserver;
  /** Receives every failed pass; the runner keeps going regardless. */
  readonly onError?: (
    error: unknown,
    pass: Extract<OutboxDispatchRunnerPass, { ok: false }>,
  ) => void;
}

export interface OutboxDispatchRunner {
  readonly kind: "ship.outbox-dispatch-runner";
  /** The dispatcher operation the runner drives. */
  readonly operationId: string;
  /** True from start until `stop()` was called. */
  readonly running: boolean;
  /** Passes executed so far, including failed ones. */
  readonly passes: number;
  /**
   * Dispatches once now, serialized with the loop so two passes never overlap
   * in one process. Usable after `stop()` for a final drain.
   */
  runOnce(): Promise<OutboxDispatchResult>;
  /** Stops after the in-flight pass; resolves once the loop has exited. Idempotent. */
  stop(): Promise<void>;
}

export const DEFAULT_OUTBOX_RUNNER_INTERVAL_MS = 1_000;
export const DEFAULT_OUTBOX_RUNNER_PASSES_PER_CYCLE = 10;
export const DEFAULT_OUTBOX_RUNNER_BACKOFF: OutboxBackoff = Object.freeze({
  initialMs: 250,
  multiplier: 2,
  maxMs: 30_000,
});

/**
 * Framework-owned dispatcher loop for one outbox dispatcher operation. The
 * loop is adaptive: while a pass returns a full batch the next pass starts at
 * once (bounded by `maxPassesPerCycle`), and only a short or empty pass waits
 * `intervalMs`, so a sustained write rate above `batchSize / intervalMs` no
 * longer grows the backlog without bound (SAPI-114). One pass is in flight at
 * a time; `runOnce()` is serialized with the loop; a failed pass backs off;
 * `stop()` returns after the in-flight pass. Run one per process per
 * dispatcher; the outbox lease keeps several processes from dispatching the
 * same record twice.
 */
export function startOutboxDispatchRunner(
  executor: AnyExecutor,
  operationId: string,
  options: OutboxDispatchRunnerOptions = {},
): OutboxDispatchRunner {
  if (typeof operationId !== "string" || operationId.length === 0) {
    throw new OutboxRunnerError(
      "SHIP_OUTBOX_RUNNER_INVALID",
      "startOutboxDispatchRunner requires the dispatcher operation id",
    );
  }
  const loop = createOutboxDispatchLoop({
    executor,
    options,
    invalid: (message) =>
      new OutboxRunnerError("SHIP_OUTBOX_RUNNER_INVALID", message, { operationId }),
    pass: (dispatchOptions) => dispatchOutbox(executor, operationId, dispatchOptions),
  });
  return Object.freeze({
    kind: "ship.outbox-dispatch-runner" as const,
    operationId,
    get running() {
      return loop.running;
    },
    get passes() {
      return loop.passes;
    },
    runOnce: loop.runOnce,
    stop: loop.stop,
  });
}

/** @internal The loop shared by `startOutboxDispatchRunner` and `startRealtimePublicationRunner`. */
export interface OutboxDispatchLoop {
  readonly running: boolean;
  readonly passes: number;
  runOnce(): Promise<OutboxDispatchResult>;
  stop(): Promise<void>;
}

/** @internal */
export function createOutboxDispatchLoop(input: {
  readonly executor: AnyExecutor;
  readonly options: OutboxDispatchRunnerOptions;
  /** Builds the error thrown for an invalid option, in the caller's error family. */
  readonly invalid: (message: string) => Error;
  /** One dispatch pass in the caller's error family. */
  readonly pass: (options: DispatchOutboxOptions) => Promise<OutboxDispatchResult>;
}): OutboxDispatchLoop {
  const { executor, options } = input;
  const intervalMs = options.intervalMs ?? DEFAULT_OUTBOX_RUNNER_INTERVAL_MS;
  const maxPasses = options.maxPassesPerCycle ?? DEFAULT_OUTBOX_RUNNER_PASSES_PER_CYCLE;
  const backoff = options.backoff ?? DEFAULT_OUTBOX_RUNNER_BACKOFF;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw input.invalid("dispatch runner intervalMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxPasses) || maxPasses < 1) {
    throw input.invalid("dispatch runner maxPassesPerCycle must be a positive integer");
  }
  if (
    typeof backoff !== "object" ||
    backoff === null ||
    !Number.isSafeInteger(backoff.initialMs) ||
    backoff.initialMs < 1
  ) {
    throw input.invalid("dispatch runner backoff must declare a positive integer initialMs");
  }
  if (typeof executor !== "object" || executor === null || typeof executor.run !== "function") {
    throw input.invalid("dispatch runner requires an executor created by createExecutor()");
  }

  const stopping = new AbortController();
  let running = true;
  let passes = 0;
  let failures = 0;
  let inFlight: Promise<unknown> = Promise.resolve();

  const dispatchOptions: DispatchOutboxOptions = {
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  /** Serializes passes: the loop and runOnce() share one queue. */
  const pass = (): Promise<OutboxDispatchRunnerPass> => {
    const next = inFlight.then(async (): Promise<OutboxDispatchRunnerPass> => {
      const startedAt = Date.now();
      passes += 1;
      try {
        const result = await input.pass(dispatchOptions);
        failures = 0;
        const outcome = { ok: true as const, result, durationMs: Date.now() - startedAt };
        options.observer?.pass(outcome);
        return outcome;
      } catch (error) {
        failures += 1;
        const outcome = {
          ok: false as const,
          error,
          durationMs: Date.now() - startedAt,
          failures,
          retryInMs: backoffDelay(backoff, failures),
        };
        options.observer?.pass(outcome);
        options.onError?.(error, outcome);
        return outcome;
      }
    });
    inFlight = next.catch(() => undefined);
    return next;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopping.signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        stopping.signal.removeEventListener("abort", done);
        clearTimeout(timer);
        resolve();
      }
      stopping.signal.addEventListener("abort", done, { once: true });
    });

  const loop = (async () => {
    while (!stopping.signal.aborted) {
      let failed = false;
      for (let burst = 0; burst < maxPasses && !stopping.signal.aborted; burst += 1) {
        const outcome = await pass();
        if (!outcome.ok) {
          await sleep(outcome.retryInMs);
          failed = true;
          break;
        }
        if (!isFullBatch(outcome.result)) break;
      }
      // A failed pass already waited its backoff; a full burst that hit the
      // cap and a short or empty pass both yield to the interval.
      if (!failed) await sleep(intervalMs);
    }
  })();

  return Object.freeze({
    get running() {
      return running;
    },
    get passes() {
      return passes;
    },
    runOnce: async () => {
      const outcome = await pass();
      if (outcome.ok) return outcome.result;
      throw outcome.error;
    },
    stop: async () => {
      running = false;
      stopping.abort();
      await loop;
      await inFlight;
    },
  });
}

/**
 * A pass whose claim filled the batch probably left more due records behind.
 * A result without `batchSize` (a custom dispatcher) is treated as full
 * whenever it claimed anything, which is the pre-adaptive behaviour.
 */
function isFullBatch(result: OutboxDispatchResult): boolean {
  const batchSize = Reflect.get(result, "batchSize");
  return typeof batchSize === "number" ? result.claimed >= batchSize : result.claimed > 0;
}
