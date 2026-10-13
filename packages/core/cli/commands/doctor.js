import chalk from "chalk";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

/**
 * `ship-api g doctor` — project health check.
 *
 * Runs a battery of cheap checks against the consumer project:
 *
 *   1. project_structure — `package.json` exists; `@sixthsummit/ship-api`
 *      is declared (dependency or devDependency).
 *   2. env_vars — for every `module.json` under `modules/<name>/`,
 *      every entry in `requiredEnvVars` is present in `process.env`.
 *      `optionalEnvVars` are reported as "info" only.
 *   3. drizzle_migrations — if `src/db/migrations/` exists, count
 *      migration files; if a `drizzle.config.{ts,js,json}` exists,
 *      surface that drizzle-kit is set up.
 *   4. audit — runs `npx audit-ci --config .audit-ci.json` if the
 *      config exists, else falls back to `npm audit --audit-level=high`.
 *      Reports the high+critical count.
 *
 * Each check returns `{ name, status: "ok" | "warn" | "fail", detail? }`.
 * Output is a chalk-colored summary; exits non-zero if any check is
 * `fail` (so it's CI-friendly).
 *
 * Pure introspection — never modifies the project. Safe to run
 * anywhere.
 */

export async function doctorCommand(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const checks = await runChecks(cwd);
  printReport(checks);
  const hasFailure = checks.some((c) => c.status === "fail");
  if (hasFailure && !opts.noExit) {
    process.exit(1);
  }
  return checks;
}

async function runChecks(cwd) {
  const results = [];
  results.push(await checkProjectStructure(cwd));
  results.push(...(await checkEnvVars(cwd)));
  results.push(await checkDrizzleMigrations(cwd));
  results.push(await checkAudit(cwd));
  return results;
}

async function checkProjectStructure(cwd) {
  const pkgPath = path.join(cwd, "package.json");
  let pkg;
  try {
    const text = await fs.readFile(pkgPath, "utf8");
    pkg = JSON.parse(text);
  } catch {
    return {
      name: "project_structure",
      status: "fail",
      detail: `package.json not found at ${pkgPath}`,
    };
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const shipDep = deps["@sixthsummit/ship-api"];
  if (!shipDep) {
    return {
      name: "project_structure",
      status: "warn",
      detail:
        "@sixthsummit/ship-api is not declared in dependencies (this might be the framework repo itself)",
    };
  }
  return {
    name: "project_structure",
    status: "ok",
    detail: `@sixthsummit/ship-api ${shipDep}`,
  };
}

async function checkEnvVars(cwd) {
  const modulesDir = path.join(cwd, "modules");
  let entries;
  try {
    entries = await fs.readdir(modulesDir, { withFileTypes: true });
  } catch {
    // No modules/ directory — nothing to check (framework repo or new
    // project). Surface as info-level warn so it's visible.
    return [
      {
        name: "env_vars",
        status: "warn",
        detail: `no modules/ directory at ${modulesDir} — skipping env-var check`,
      },
    ];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(modulesDir, entry.name, "module.json");
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      continue; // module without a manifest — skip silently
    }
    const required = manifest.requiredEnvVars ?? [];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length === 0) {
      results.push({
        name: `env_vars.${entry.name}`,
        status: "ok",
        detail:
          required.length === 0
            ? "no required env vars"
            : `${required.length} required vars all set`,
      });
    } else {
      results.push({
        name: `env_vars.${entry.name}`,
        status: "fail",
        detail: `missing required env vars: ${missing.join(", ")}`,
      });
    }
  }

  if (results.length === 0) {
    results.push({
      name: "env_vars",
      status: "warn",
      detail: "no module.json manifests found under modules/",
    });
  }
  return results;
}

async function checkDrizzleMigrations(cwd) {
  const migrationsDir = path.join(cwd, "src", "db", "migrations");
  const configCandidates = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.json"];
  let configFound;
  for (const c of configCandidates) {
    try {
      await fs.access(path.join(cwd, c));
      configFound = c;
      break;
    } catch {
      // try next
    }
  }

  let migrationCount = 0;
  try {
    const entries = await fs.readdir(migrationsDir);
    migrationCount = entries.filter((f) => f.endsWith(".sql")).length;
  } catch {
    // no migrations directory
  }

  if (!configFound && migrationCount === 0) {
    return {
      name: "drizzle_migrations",
      status: "warn",
      detail: "drizzle not configured (no drizzle.config.* and no migrations)",
    };
  }
  if (configFound && migrationCount === 0) {
    return {
      name: "drizzle_migrations",
      status: "warn",
      detail: `${configFound} present but no migrations generated yet — run \`npm run db:generate\``,
    };
  }
  return {
    name: "drizzle_migrations",
    status: "ok",
    detail: `${migrationCount} migration file${migrationCount === 1 ? "" : "s"} (${configFound ?? "no config file detected"})`,
  };
}

async function checkAudit(cwd) {
  const configPath = path.join(cwd, ".audit-ci.json");
  let configExists = false;
  try {
    await fs.access(configPath);
    configExists = true;
  } catch {
    // fall through
  }

  // Always parse npm audit JSON so we can surface counts; audit-ci is
  // run only when the config exists (it gates the build via exit code).
  const auditJson = await runCmd("npm", ["audit", "--json", "--audit-level=info"], { cwd });
  let counts = { high: 0, critical: 0, moderate: 0 };
  try {
    counts = JSON.parse(auditJson.stdout || "{}").metadata?.vulnerabilities ?? counts;
  } catch {
    return {
      name: "audit",
      status: "warn",
      detail: "could not parse `npm audit --json` output",
    };
  }
  const high = counts.high ?? 0;
  const critical = counts.critical ?? 0;

  if (configExists) {
    const result = await runCmd("npx", ["audit-ci", "--config", ".audit-ci.json"], { cwd });
    if (result.code === 0) {
      return {
        name: "audit",
        status: "ok",
        detail: `audit-ci passes (high=${high}, critical=${critical})`,
      };
    }
    return {
      name: "audit",
      status: "fail",
      detail: `audit-ci failed (high=${high}, critical=${critical}); run \`npm audit fix\``,
    };
  }

  if (high > 0 || critical > 0) {
    return {
      name: "audit",
      status: "fail",
      detail: `${high} high + ${critical} critical findings; run \`npm audit fix\` and add a .audit-ci.json gate`,
    };
  }
  return {
    name: "audit",
    status: "ok",
    detail: `no high/critical findings (${counts.moderate ?? 0} moderate; consider adding .audit-ci.json)`,
  };
}

function runCmd(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    child.on("error", () => resolve({ code: -1, stdout, stderr }));
  });
}

function printReport(checks) {
  const symbol = (status) =>
    status === "ok" ? chalk.green("✔") : status === "warn" ? chalk.yellow("!") : chalk.red("✗");
  const label = (status) =>
    status === "ok"
      ? chalk.green("ok  ")
      : status === "warn"
        ? chalk.yellow("warn")
        : chalk.red("fail");

  console.log("");
  console.log(chalk.bold("ship-api doctor"));
  console.log("");
  for (const c of checks) {
    const detail = c.detail ? chalk.dim(` — ${c.detail}`) : "";
    console.log(`  ${symbol(c.status)} ${label(c.status)}  ${c.name}${detail}`);
  }
  console.log("");

  const counts = checks.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {
    ok: 0,
    warn: 0,
    fail: 0,
  });
  console.log(chalk.dim(`  summary: ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail`));
  console.log("");
}

// Exposed for testing.
export const __test = {
  checkProjectStructure,
  checkEnvVars,
  checkDrizzleMigrations,
};
