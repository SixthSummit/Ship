/**
 * `ship-angular doctor` — health check for an existing ShipAngular project.
 *
 * Surfaces the most common drift / misconfig patterns so a developer (or
 * Claude Code) can fix them deterministically. Phase 3 minimal scope:
 *
 * - Version drift across package.json files (root + workspace + template).
 * - Missing required providers in app.config.ts.
 * - SSR misconfig: server.ts exists but outputMode != 'server', or vice versa.
 *
 * Phase 3.x extends this with: dependency audit, conformance-suite presence
 * check on every adapter, ESLint custom-rules wiring check.
 */
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';

const SUCCESS = '✓';
const WARN = '⚠';
const ERR = '✘';

class Report {
  constructor() {
    this.findings = [];
  }
  ok(msg) {
    this.findings.push({ kind: 'ok', msg });
  }
  warn(msg) {
    this.findings.push({ kind: 'warn', msg });
  }
  err(msg) {
    this.findings.push({ kind: 'err', msg });
  }
  print() {
    for (const f of this.findings) {
      const icon =
        f.kind === 'ok'
          ? chalk.green(SUCCESS)
          : f.kind === 'warn'
            ? chalk.yellow(WARN)
            : chalk.red(ERR);
      console.log(`${icon} ${f.msg}`);
    }
    const errs = this.findings.filter(f => f.kind === 'err').length;
    const warns = this.findings.filter(f => f.kind === 'warn').length;
    console.log();
    if (errs === 0 && warns === 0) {
      console.log(chalk.green.bold('Everything looks good.'));
    } else if (errs === 0) {
      console.log(chalk.yellow(`${warns} warning(s); no blockers.`));
    } else {
      console.log(chalk.red.bold(`${errs} error(s), ${warns} warning(s).`));
    }
    return errs === 0;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function checkVersionDrift(report, cwd) {
  const pkgPath = resolve(cwd, 'package.json');
  if (!(await exists(pkgPath))) {
    report.err('package.json not found in the current directory.');
    return;
  }
  const pkg = await readJson(pkgPath);
  const shipDep = pkg.dependencies?.['@sixthsummit/ship-angular'];
  if (!shipDep) {
    report.warn(
      'No @sixthsummit/ship-angular dependency found. Run `ng add @sixthsummit/ship-angular@alpha`.'
    );
    return;
  }
  report.ok(`@sixthsummit/ship-angular declared at ${shipDep}.`);

  // Cross-check Angular major versions across deps.
  const angularDeps = Object.entries(pkg.dependencies ?? {})
    .concat(Object.entries(pkg.devDependencies ?? {}))
    .filter(([k]) => k.startsWith('@angular/') && !k.startsWith('@angular/cli'));
  const majors = new Set(angularDeps.map(([, v]) => extractMajor(v)).filter(Boolean));
  if (majors.size > 1) {
    report.err(
      `Mixed Angular majors detected: ${[...majors].join(', ')}. Align via: pnpm exec ng update @angular/core @angular/cli.`
    );
  } else if (majors.size === 1) {
    report.ok(`Angular packages aligned at major ${[...majors][0]}.`);
  }
}

function extractMajor(versionRange) {
  const m = String(versionRange).match(/(\d+)/);
  return m ? m[1] : null;
}

async function checkProviders(report, cwd) {
  const cfgPath = resolve(cwd, 'src/app/app.config.ts');
  if (!(await exists(cfgPath))) {
    report.warn('src/app/app.config.ts not found. Skipping provider check.');
    return;
  }
  const cfg = await readFile(cfgPath, 'utf8');
  const required = [
    { needle: 'provideHttpClient', msg: 'provideHttpClient' },
    { needle: 'authInterceptor', msg: 'authInterceptor (via withInterceptors([authInterceptor]))' },
    { needle: 'AuthService', msg: 'AuthService import' },
  ];
  for (const r of required) {
    if (!cfg.includes(r.needle)) {
      report.warn(`app.config.ts is missing ${r.msg}. Add it per packages/core/CLAUDE.md.`);
    }
  }
  if (cfg.includes('provideZoneChangeDetection')) {
    report.warn(
      'Using provideZoneChangeDetection. ShipAngular v4 prefers provideZonelessChangeDetection (zone.js out of bundle).'
    );
  } else if (cfg.includes('provideZonelessChangeDetection')) {
    report.ok('Zoneless change detection wired.');
  }
  if (cfg.includes('APP_INITIALIZER')) {
    report.warn(
      'Using deprecated APP_INITIALIZER token. Replace with provideAppInitializer(() => ...).'
    );
  }
}

async function checkSsrConsistency(report, cwd) {
  const ngJsonPath = resolve(cwd, 'angular.json');
  if (!(await exists(ngJsonPath))) {
    report.warn('angular.json not found. Skipping SSR consistency check.');
    return;
  }
  const ngJson = await readJson(ngJsonPath);
  const projectName = ngJson.defaultProject ?? Object.keys(ngJson.projects ?? {})[0];
  const project = projectName ? ngJson.projects?.[projectName] : null;
  if (!project) {
    report.warn('No project found in angular.json. Skipping SSR check.');
    return;
  }
  const buildOpts = project.architect?.build?.options ?? {};
  const hasServer = !!buildOpts.server;
  const outputMode = buildOpts.outputMode;
  const serverFileExists = await exists(resolve(cwd, 'src/server.ts'));
  if (hasServer && !serverFileExists) {
    report.err('angular.json declares a `server` entry but src/server.ts is missing.');
  }
  if (serverFileExists && !hasServer) {
    report.err('src/server.ts exists but angular.json has no `server` entry.');
  }
  if (hasServer && outputMode !== 'server') {
    report.warn(
      `angular.json has a server entry but outputMode is "${outputMode}". Set outputMode: "server" for SSR builds.`
    );
  }
  if (hasServer && outputMode === 'server') {
    report.ok('SSR consistency check passed.');
  }
}

export async function runDoctor() {
  const cwd = process.cwd();
  console.log(chalk.bold(`ShipAngular doctor — ${cwd}\n`));
  const report = new Report();
  await checkVersionDrift(report, cwd);
  await checkProviders(report, cwd);
  await checkSsrConsistency(report, cwd);
  const ok = report.print();
  process.exit(ok ? 0 : 1);
}
