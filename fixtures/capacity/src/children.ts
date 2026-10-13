import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const harnessDirectory = resolve(sourceDirectory, "..");

export interface ManagedChild {
  readonly name: string;
  readonly process: ChildProcess;
  /** The JSON line the child printed when it became ready. */
  readonly ready: Promise<Record<string, unknown>>;
  readonly stderr: string[];
  /** Stops the child and returns the JSON summary line it printed on the way out, if any. */
  stop(): Promise<Record<string, unknown> | undefined>;
}

/**
 * Spawns one harness entry script in a fresh Node process through tsx. The
 * child prints `{"ready":true,...}` once serving and `{"summary":true,...}`
 * right before it exits on SIGTERM; both lines are handed back to the parent.
 */
export function spawnChild(
  name: string,
  script: string,
  env: Record<string, string>,
): ManagedChild {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(sourceDirectory, script)], {
    cwd: harnessDirectory,
    env: { ...process.env, ...env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString());
    process.stderr.write(`[${name}] ${chunk.toString()}`);
  });
  let resolveReady: (line: Record<string, unknown>) => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  ready.catch(() => undefined);
  let summary: Record<string, unknown> | undefined;
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.length === 0) continue;
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.stdout.write(`[${name}] ${line}\n`);
        continue;
      }
      if (parsed.ready === true) resolveReady(parsed);
      else if (parsed.summary === true) summary = parsed;
      else process.stdout.write(`[${name}] ${line}\n`);
    }
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => {
      rejectReady(new Error(`${name} exited with ${code} before it was ready`));
      resolveExit(code);
    });
  });
  return {
    name,
    process: child,
    ready,
    stderr,
    stop: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        await exited;
        clearTimeout(timer);
      }
      return summary;
    },
  };
}

/** Milliseconds a child may take to print its ready line. */
export const CHILD_READY_TIMEOUT_MS = 60_000;

export function withTimeout<TValue>(
  promise: Promise<TValue>,
  ms: number,
  label: string,
): Promise<TValue> {
  return new Promise<TValue>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`timed out waiting for ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}
