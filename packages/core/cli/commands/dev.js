import chalk from "chalk";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

/**
 * `ship-api dev` — local-stack orchestrator.
 *
 * Brings up the dependency containers (Postgres, Redis, optional OTel
 * collector) via Docker Compose, then runs the project's dev script with
 * hot reload, then polls a health endpoint until it goes green and prints
 * the URL — the "new project just works" experience.
 *
 *   --bare    Skip Docker. Use this when Postgres/Redis are already running
 *             on the host (or you're shelling into a remote stack).
 *   --reset   `docker compose down -v` before starting — drops volumes for
 *             a clean slate (and forces fresh migrations on next boot).
 *   --port    Override the polled port (defaults to 3000 / $PORT).
 *
 * Implementation notes:
 *
 *   • Compose file discovery: looks for `compose.yml`, `compose.yaml`,
 *     `docker-compose.yml`, `docker-compose.yaml` in cwd. If none, behaves
 *     as `--bare`.
 *   • Service selection: spins up *only* dependency services (`postgres`,
 *     `redis`, `jaeger`, `otel-collector`) — never the `api` service,
 *     since the point of `dev` is to run the app via `tsx watch` for
 *     hot reload. (`jaeger` is the v4 template's trace viewer; the
 *     legacy `otel-collector` name is kept for v3 / older v4 templates
 *     that haven't been updated.)
 *   • Health probe: tries `/livez`, then `/healthz`, then `/health-check`,
 *     then `/`. First non-5xx response wins. Polls every 500ms with a 60s
 *     timeout.
 *   • Signal handling: forwards SIGINT/SIGTERM to the npm child. Compose
 *     stays running so the next `dev` invocation reuses warm containers
 *     (use `--reset` to tear down explicitly).
 */

const DEPENDENCY_SERVICES = ["postgres", "redis", "jaeger", "otel-collector"];
const HEALTH_PATHS = ["/livez", "/healthz", "/health-check", "/"];
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 500;

export async function devCommand(options = {}) {
  const cwd = process.cwd();
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  const useDocker = !options.bare;
  const reset = Boolean(options.reset);

  console.log(chalk.blue("🚀 ship-api dev"));

  let composeFile = null;
  if (useDocker) {
    composeFile = await findComposeFile(cwd);
    if (!composeFile) {
      console.log(
        chalk.yellow(
          "⚠ no docker-compose.yml found — running in --bare mode (assumes Postgres/Redis are already up)",
        ),
      );
    }
  }

  if (composeFile && reset) {
    console.log(chalk.gray(`↻ docker compose down -v (${composeFile})`));
    await runToCompletion("docker", ["compose", "-f", composeFile, "down", "-v"], { cwd });
  }

  if (composeFile) {
    const services = await selectExistingServices(composeFile, cwd, DEPENDENCY_SERVICES);
    if (services.length === 0) {
      console.log(
        chalk.yellow(
          `⚠ ${composeFile} has no services matching ${DEPENDENCY_SERVICES.join(", ")} — skipping compose up`,
        ),
      );
    } else {
      console.log(chalk.gray(`↑ docker compose up -d ${services.join(" ")}`));
      const composeUp = await runToCompletion(
        "docker",
        ["compose", "-f", composeFile, "up", "-d", ...services],
        { cwd },
      );
      if (composeUp.code !== 0) {
        throw new Error(`docker compose up failed (exit ${composeUp.code})`);
      }
    }
  }

  // Pick the dev script. Templates expose `local` (v3) or `dev` (v4).
  const devScript = await pickDevScript(cwd);
  console.log(chalk.gray(`▶ npm run ${devScript}`));

  const npmChild = spawn("npm", ["run", devScript], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  let cleanedUp = false;
  const cleanup = (signal) => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (!npmChild.killed) npmChild.kill(signal);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  const childExit = new Promise((resolve) => {
    npmChild.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // Race the health probe vs. an early child exit.
  const healthResult = await Promise.race([
    pollHealth(`http://localhost:${port}`),
    childExit.then((r) => ({ kind: "child-exited", ...r })),
  ]);

  if (healthResult.kind === "child-exited") {
    throw new Error(
      `dev process exited before becoming healthy (code=${healthResult.code} signal=${healthResult.signal})`,
    );
  }
  if (!healthResult.ok) {
    console.log(
      chalk.yellow(
        `⚠ ${healthResult.reason}. The server may still be starting — try opening http://localhost:${port} in a moment.`,
      ),
    );
  } else {
    console.log(
      chalk.green(
        `✓ healthy at http://localhost:${port}${healthResult.path} — opening in your browser`,
      ),
    );
  }

  // Stay attached to the npm child so logs flow until Ctrl+C.
  const { code } = await childExit;
  if (code !== 0 && code !== null) {
    process.exitCode = code;
  }
}

// Exported for tests. Internal helpers used by `devCommand`.
export const __test = {
  findComposeFile: (...args) => findComposeFile(...args),
  selectExistingServices: (...args) => selectExistingServices(...args),
  pickDevScript: (...args) => pickDevScript(...args),
};

async function findComposeFile(cwd) {
  const candidates = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"];
  for (const name of candidates) {
    const full = path.join(cwd, name);
    try {
      await fs.access(full);
      return name;
    } catch {
      // try next
    }
  }
  return null;
}

async function selectExistingServices(composeFile, cwd, candidates) {
  // Cheap parse — read the file and look for top-level service keys via
  // the indent-aware regex `\n  <name>:`. Avoids a YAML dep for a CLI tool.
  const text = await fs.readFile(path.join(cwd, composeFile), "utf8");
  const out = [];
  for (const name of candidates) {
    const re = new RegExp(`(?:^|\\n)  ${escapeRegex(name)}:`, "m");
    if (re.test(text)) out.push(name);
  }
  return out;
}

async function pickDevScript(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    const scripts = pkg.scripts ?? {};
    if (scripts.dev) return "dev";
    if (scripts.local) return "local";
    if (scripts.start) return "start";
  } catch {
    // fall through
  }
  return "local";
}

async function pollHealth(baseUrl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const p of HEALTH_PATHS) {
      try {
        const res = await fetch(`${baseUrl}${p}`, {
          // Treat any 2xx/3xx/4xx as "the server is reachable enough".
          // 5xx (or no response) keeps polling.
        });
        if (res.status < 500) {
          return { kind: "healthy", ok: true, path: p, status: res.status };
        }
      } catch {
        // connection refused / DNS / network — still booting
      }
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  return {
    kind: "healthy",
    ok: false,
    reason: `no health endpoint became reachable within ${HEALTH_TIMEOUT_MS / 1000}s`,
  };
}

function runToCompletion(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
