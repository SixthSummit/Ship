import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const script = fileURLToPath(new URL('./download-core-artifact.mjs', import.meta.url));

test('artifact download proves identity and digest before it writes the built package', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ship-artifact-tests-'));
  try {
    mkdirSync(join(temporary, 'bin'));
    mkdirSync(join(temporary, 'fixture/lib'), { recursive: true });
    writeFileSync(join(temporary, 'fixture/lib/package.json'), '{"fixture":true}');
    const archive = join(temporary, 'proof.zip');
    execFileSync('zip', ['-qr', archive, 'lib'], { cwd: join(temporary, 'fixture') });
    const digest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
    writeFileSync(join(temporary, 'fixture/unexpected.txt'), 'outside the build');
    const foreignArchive = join(temporary, 'foreign.zip');
    execFileSync('zip', ['-qr', foreignArchive, 'lib', 'unexpected.txt'], {
      cwd: join(temporary, 'fixture'),
    });
    const foreignDigest = `sha256:${createHash('sha256').update(readFileSync(foreignArchive)).digest('hex')}`;
    const gh = join(temporary, 'bin/gh');
    // Replace only the remote GitHub boundary. SHA256, ZIP validation, and
    // extraction still run through the production script and operating system.
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.includes('--slurp')) {
  assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/SixthSummit/ship-angular/actions/runs/123/artifacts?per_page=100']);
  process.stdout.write(process.env.MOCK_PAGES);
} else {
  assert.deepEqual(args, ['api', 'repos/SixthSummit/ship-angular/actions/artifacts/7/zip']);
  process.stdout.write(process.env.MOCK_EMPTY === '1' ? '' : fs.readFileSync(process.env.MOCK_ARCHIVE));
}
`
    );
    chmodSync(gh, 0o755);
    const valid = {
      id: 7,
      name: 'core-package-build',
      expired: false,
      workflow_run: { id: 123 },
      digest,
    };
    const cases = [
      ['success', [valid], false, null],
      ['wrong-run', [{ ...valid, workflow_run: { id: 124 } }], false, /belong to this run/],
      [
        'wrong-digest',
        [{ ...valid, digest: `sha256:${'0'.repeat(64)}` }],
        false,
        /digest mismatch/,
      ],
      ['duplicates', [valid, valid], false, /exactly one/],
      ['missing-artifact', [], false, /exactly one/],
      ['expired', [{ ...valid, expired: true }], false, /unexpired/],
      ['invalid-id', [{ ...valid, id: 0 }], false, /unexpired/],
      ['empty-archive', [valid], true, /archive is empty/],
      ['missing-digest', [{ ...valid, digest: null }], false, /declare a SHA256/],
      ['missing-run-metadata', [{ ...valid, workflow_run: undefined }], false, /unexpired/],
      [
        'missing-run',
        [valid],
        false,
        /must identify this workflow run/,
        archive,
        { GITHUB_RUN_ID: undefined },
      ],
      [
        'invalid-repository',
        [valid],
        false,
        /must identify this workflow run/,
        archive,
        { GITHUB_REPOSITORY: 'invalid' },
      ],
      [
        'missing-repository',
        [valid],
        false,
        /must identify this workflow run/,
        archive,
        { GITHUB_REPOSITORY: undefined },
      ],
      [
        'foreign-directory',
        [{ ...valid, digest: foreignDigest }],
        false,
        /only the built lib and schematics/,
        foreignArchive,
      ],
    ];
    for (const [name, artifacts, empty, error, caseArchive = archive, overrides = {}] of cases) {
      const cwd = join(temporary, name);
      mkdirSync(join(cwd, '../packages/angular'), { recursive: true });
      const run = spawnSync(process.execPath, [script], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(temporary, 'bin')}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'SixthSummit/ship-angular',
          GITHUB_RUN_ID: '123',
          MOCK_PAGES: JSON.stringify([{ artifacts }]),
          MOCK_EMPTY: empty ? '1' : '0',
          MOCK_ARCHIVE: caseArchive,
          ...overrides,
        },
      });
      const extracted = join(cwd, '../packages/angular/lib/package.json');
      if (error) {
        assert.notEqual(run.status, 0, name);
        assert.match(run.stderr, error, name);
        assert.equal(existsSync(extracted), false, `${name} must fail before extraction`);
      } else {
        assert.equal(run.status, 0, run.stderr);
        assert.equal(readFileSync(extracted, 'utf8'), '{"fixture":true}');
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
