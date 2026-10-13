#!/usr/bin/env node
import { spawn } from 'node:child_process';
/**
 * Agent eval harness runner.
 *
 * Runs graders against an explicit prepared workspace after an agent has
 * attempted a brief. It never grades the untouched framework checkout as if
 * an agent had completed the task.
 *
 * Usage:
 *
 *   node evals/run.js eval-001-add-module --workspace /tmp/eval-app
 *   node evals/run.js --all --app --workspace /tmp/eval-app
 *   node evals/run.js eval-001-add-module --workspace /tmp/eval-app --record --run-id run-123
 */
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const tasksDir = join(__dirname, 'agent-tasks');

async function listEvals() {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

function runGrader(taskId, workspace) {
  return new Promise(resolve => {
    const start = Date.now();
    const grader = join(tasksDir, taskId, 'grade.sh');
    const child = spawn('bash', [grader], {
      cwd: workspace,
      env: { ...process.env, SHIP_ANGULAR_EVAL_WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => {
      resolve({
        id: taskId,
        passed: code === 0,
        durationMs: Date.now() - start,
        stdout: stdout.trim(),
        error: code !== 0 ? stderr.trim() || stdout.trim() : undefined,
      });
    });
  });
}

async function readVersion() {
  const pkg = JSON.parse(
    await readFile(join(repoRoot, '../packages/angular/package.json'), 'utf8')
  );
  return pkg.version;
}

async function readEvalMeta(taskId) {
  try {
    const raw = await readFile(join(tasksDir, taskId, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { target: 'framework' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const record = args.includes('--record');
  const workspaceIndex = args.indexOf('--workspace');
  const runIdIndex = args.indexOf('--run-id');
  const workspaceArgument = workspaceIndex < 0 ? undefined : args[workspaceIndex + 1];
  const runId = runIdIndex < 0 ? undefined : args[runIdIndex + 1];
  const optionValues = new Set(
    [workspaceIndex, runIdIndex].filter(index => index >= 0).map(index => args[index + 1])
  );
  const positional = args.filter(
    argument => !argument.startsWith('-') && !optionValues.has(argument)
  );
  const targetFilter = args.includes('--app')
    ? 'app'
    : args.includes('--framework')
      ? 'framework'
      : null;
  if (workspaceArgument === undefined || workspaceArgument.startsWith('-')) {
    console.error(
      'An explicit --workspace is required. Prepare an isolated app/worktree, let an agent attempt the brief, then grade that workspace.'
    );
    process.exit(2);
  }
  const workspace = resolve(workspaceArgument);
  try {
    await access(workspace);
  } catch {
    console.error(`Eval workspace does not exist: ${workspace}`);
    process.exit(2);
  }
  if (record && (runId === undefined || runId.startsWith('-'))) {
    console.error('--record requires --run-id so stored results identify a real agent execution.');
    process.exit(2);
  }
  if (runId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    console.error('--run-id may contain only letters, digits, dots, underscores, and hyphens.');
    process.exit(2);
  }
  const allEvalIds = all ? await listEvals() : positional;

  if (allEvalIds.length === 0) {
    console.error(
      'Usage: node evals/run.js <eval-id> --workspace <path> [--record --run-id <id>]\n' +
        '       node evals/run.js --all --workspace <path> [--framework | --app]\n' +
        '\n' +
        'Without --framework / --app, --all defaults to framework-target evals only\n' +
        '(app-target evals require a generated test-app sandbox; see evals/README.md).'
    );
    process.exit(2);
  }

  // When `--all` is given without an explicit target filter, default to
  // framework-target only — app-target evals need a sandbox the runner
  // doesn't yet spawn (see evals/README.md).
  const ids = [];
  for (const id of allEvalIds) {
    const meta = await readEvalMeta(id);
    if (positional.includes(id)) {
      ids.push(id); // explicit positional always runs
      continue;
    }
    if (targetFilter && meta.target !== targetFilter) continue;
    if (!targetFilter && meta.target !== 'framework') continue;
    ids.push(id);
  }

  if (ids.length === 0) {
    console.error('No evals matched the filter. Try --app to run app-target evals.');
    process.exit(2);
  }

  console.log(`Running ${ids.length} eval(s)...\n`);
  const results = [];
  for (const id of ids) {
    process.stdout.write(`  ${id}: `);
    const r = await runGrader(id, workspace);
    console.log(
      r.passed ? `PASS (${r.durationMs}ms)` : `FAIL (${r.durationMs}ms)\n    ${r.error ?? ''}`
    );
    results.push(r);
  }

  const passed = results.filter(r => r.passed).length;
  const passRate = results.length === 0 ? 0 : passed / results.length;
  console.log(`\n${passed}/${results.length} passed (${(passRate * 100).toFixed(1)}%)`);

  if (record) {
    const version = await readVersion();
    const report = {
      version,
      runId,
      target: targetFilter ?? (await readEvalMeta(ids[0])).target,
      ranAt: new Date().toISOString(),
      results: results.map(r => {
        const out = { id: r.id, passed: r.passed, durationMs: r.durationMs };
        if (r.error) out.error = r.error;
        return out;
      }),
      passRate,
    };
    const outPath = join(__dirname, 'results', `${version}-${runId}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`\n✓ Recorded to ${outPath}`);
  }

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('Eval harness error:', err);
  process.exit(2);
});
