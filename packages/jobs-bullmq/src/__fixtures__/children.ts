import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(fixturesDirectory, "../..");

export interface ChildWorker {
  readonly process: ChildProcess;
  /** Resolves once the child printed `ready`. */
  readonly ready: Promise<void>;
  /** Resolves with the exit code once the child exits. */
  readonly exited: Promise<number | null>;
  stop(): Promise<number | null>;
}

/** Spawns a fixture entry script in a fresh Node process through tsx. */
export function spawnChildWorker(script: string, env: Record<string, string>): ChildWorker {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(fixturesDirectory, script)], {
    cwd: packageDirectory,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let markReady: () => void = () => undefined;
  let failReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    markReady = resolveReady;
    failReady = rejectReady;
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("ready")) markReady();
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.on("exit", (code) => {
      failReady(new Error(`child ${script} exited with ${code} before it was ready`));
      resolveExit(code);
    });
  });
  ready.catch(() => undefined);
  return {
    process: child,
    ready,
    exited,
    stop: async () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      return exited;
    },
  };
}
