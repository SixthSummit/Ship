// Use GitHub's REST archive endpoint while the current download action's ZIP
// dependency emits DEP0005. Retain exact-run selection and mandatory digest proof.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? '')) {
  throw new Error('GITHUB_REPOSITORY and GITHUB_RUN_ID must identify this workflow run.');
}

const pages = JSON.parse(
  execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    ],
    { encoding: 'utf8' }
  )
);
const matches = pages
  .flatMap(page => page.artifacts)
  .filter(artifact => artifact.name === 'core-package-build');
if (matches.length !== 1) throw new Error('Expected exactly one core-package-build artifact.');
const artifact = matches[0];
if (
  artifact.expired !== false ||
  String(artifact.workflow_run?.id) !== runId ||
  !Number.isSafeInteger(artifact.id) ||
  artifact.id <= 0 ||
  !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
) {
  throw new Error('Artifact must be unexpired, belong to this run, and declare a SHA256 digest.');
}

const temporary = mkdtempSync(join(tmpdir(), 'ship-core-artifact-'));
try {
  const archive = join(temporary, 'artifact.zip');
  const descriptor = openSync(archive, 'w');
  try {
    execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], {
      stdio: ['ignore', descriptor, 'inherit'],
    });
  } finally {
    closeSync(descriptor);
  }
  const bytes = readFileSync(archive);
  if (bytes.length === 0) throw new Error('Artifact archive is empty.');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== artifact.digest) throw new Error('Artifact SHA256 digest mismatch.');
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
  if (
    !entries.includes('lib/package.json') ||
    entries.some(
      entry =>
        (!entry.startsWith('lib/') && !entry.startsWith('schematics/')) ||
        entry.split('/').includes('..')
    )
  ) {
    throw new Error('Artifact must contain only the built lib and schematics directories.');
  }
  execFileSync('unzip', ['-q', '-o', archive, '-d', resolve('../packages/angular')], {
    stdio: 'inherit',
  });
  console.log(`Verified core-package-build ${artifact.id} from run ${runId}: ${digest}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
