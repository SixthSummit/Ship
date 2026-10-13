#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = dirname(fileURLToPath(import.meta.url));
const tasksRoot = join(evalRoot, 'agent-tasks');
const taskIds = readdirSync(tasksRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const failures = [];
const requiredOperationSymbols = new Map([
  ['eval-001-add-module', 'createOperationMutation'],
  ['eval-005-streaming-chat', 'createOperationStream'],
  ['eval-006-websocket-subscription', 'createOperationSocket'],
  ['eval-007-file-upload', 'createOperationUpload'],
  ['eval-008-session-auth', 'OperationSessionAuthAdapter'],
  ['eval-009-idempotency-and-rate-limit', 'createPolicyClient'],
]);

for (const taskId of taskIds) {
  const directory = join(tasksRoot, taskId);
  const briefPath = join(directory, 'brief.md');
  const gradePath = join(directory, 'grade.sh');
  const metaPath = join(directory, 'meta.json');

  for (const path of [briefPath, gradePath, metaPath]) {
    try {
      statSync(path);
    } catch {
      failures.push(`${taskId}: missing ${path.slice(directory.length + 1)}`);
    }
  }
  if (failures.some(failure => failure.startsWith(`${taskId}: missing`))) continue;

  const brief = readFileSync(briefPath, 'utf8');
  const grade = readFileSync(gradePath, 'utf8');
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    failures.push(`${taskId}: meta.json is not valid JSON`);
    continue;
  }

  if (!brief.startsWith(`# ${taskId}`)) failures.push(`${taskId}: brief heading must match its ID`);
  if (!['app', 'framework'].includes(meta.target)) failures.push(`${taskId}: invalid target`);
  if (!['operation-client', 'third-party-rest'].includes(meta.architecture)) {
    failures.push(`${taskId}: architecture must classify the contract under test`);
  }
  if (!grade.includes('set -euo pipefail')) failures.push(`${taskId}: grader is not fail-fast`);
  if (!grade.includes('pnpm run ci'))
    failures.push(`${taskId}: grader must run the app quality gate`);
  if (/\b(?:npm|npx)\s+(?:run|test|install|ci|start|exec)\b/.test(`${brief}\n${grade}`)) {
    failures.push(`${taskId}: uses a retired npm/npx project command`);
  }
  if (
    /(?:migrate-rest-to-hono|provideShipApiClient|withCsrf|withIdempotency|withRateLimit)/.test(
      `${brief}\n${grade}`
    )
  ) {
    failures.push(`${taskId}: teaches the retired ShipAPI integration path`);
  }
  const required = requiredOperationSymbols.get(taskId);
  if (required !== undefined && !brief.includes(required)) {
    failures.push(`${taskId}: brief must require ${required}`);
  }
  const syntax = spawnSync('bash', ['-n', gradePath], { encoding: 'utf8' });
  if (syntax.status !== 0) failures.push(`${taskId}: invalid shell: ${syntax.stderr.trim()}`);
}

if (taskIds.length === 0) failures.push('no eval tasks found');

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log(`Validated ${taskIds.length} agent eval definitions.`);
