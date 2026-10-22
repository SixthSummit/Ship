#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { brotliCompressSync, gzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, '..');

const BASELINE_PATH = path.join(repoRoot, '.bundle-baseline.json');

const entrypoints = [
  { name: '.', file: 'sixthsummit-ship-angular', types: 'index.d.ts' },
  {
    name: './operations',
    file: 'sixthsummit-ship-angular-operations',
    types: 'operations/index.d.ts',
  },
  {
    name: './ship-api',
    file: 'sixthsummit-ship-angular-ship-api',
    types: 'ship-api/index.d.ts',
  },
  { name: './query', file: 'sixthsummit-ship-angular-query', types: 'query/index.d.ts' },
  { name: './auth', file: 'sixthsummit-ship-angular-auth', types: 'auth/index.d.ts' },
  {
    name: './firebase-auth',
    file: 'sixthsummit-ship-angular-firebase-auth',
    types: 'firebase-auth/index.d.ts',
  },
  { name: './download', file: 'sixthsummit-ship-angular-download', types: 'download/index.d.ts' },
  { name: './upload', file: 'sixthsummit-ship-angular-upload', types: 'upload/index.d.ts' },
  { name: './stream', file: 'sixthsummit-ship-angular-stream', types: 'stream/index.d.ts' },
  { name: './socket', file: 'sixthsummit-ship-angular-socket', types: 'socket/index.d.ts' },
  {
    name: './realtime',
    file: 'sixthsummit-ship-angular-realtime',
    types: 'realtime/index.d.ts',
  },
  { name: './push', file: 'sixthsummit-ship-angular-push', types: 'push/index.d.ts' },
  { name: './console', file: 'sixthsummit-ship-angular-console', types: 'console/index.d.ts' },
  { name: './forms', file: 'sixthsummit-ship-angular-forms', types: 'forms/index.d.ts' },
  { name: './testing', file: 'sixthsummit-ship-angular-testing', types: 'testing/index.d.ts' },
  { name: './hono-v4', file: 'sixthsummit-ship-angular-hono-v4', types: 'hono-v4/index.d.ts' },
  {
    name: './legacy-rest',
    file: 'sixthsummit-ship-angular-legacy-rest',
    types: 'legacy-rest/index.d.ts',
  },
];

const targets = entrypoints.flatMap(entrypoint => [
  {
    name: `@sixthsummit/ship-angular${entrypoint.name === '.' ? '' : entrypoint.name.slice(1)} (runtime)`,
    files: [`../packages/angular/lib/fesm2022/${entrypoint.file}.mjs`],
  },
  {
    name: `@sixthsummit/ship-angular${entrypoint.name === '.' ? '' : entrypoint.name.slice(1)} (types)`,
    files: [`../packages/angular/lib/${entrypoint.types}`],
  },
]);

async function measure(targetSpec) {
  const files = targetSpec.files.map(file => path.join(repoRoot, file));
  if (files.length === 0) throw new Error(`${targetSpec.name} has no build artifacts`);
  let raw = 0;
  let gz = 0;
  let br = 0;
  for (const f of files) {
    let buf;
    try {
      buf = await fs.readFile(f);
    } catch {
      throw new Error(`${targetSpec.name} is missing ${path.relative(repoRoot, f)}`);
    }
    raw += buf.byteLength;
    gz += gzipSync(buf).byteLength;
    br += brotliCompressSync(buf).byteLength;
  }
  return { name: targetSpec.name, fileCount: files.length, raw, gz, br };
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function pct(prev, current) {
  if (!prev) return '+new';
  const delta = ((current - prev) / prev) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

async function loadBaseline() {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const measurements = [];
  for (const target of targets) {
    measurements.push(await measure(target));
  }

  const totalRaw = measurements.reduce((sum, m) => sum + m.raw, 0);
  const totalGz = measurements.reduce((sum, m) => sum + m.gz, 0);
  const totalBr = measurements.reduce((sum, m) => sum + m.br, 0);

  const baseline = await loadBaseline();
  const args = new Set(process.argv.slice(2));
  const updateBaseline = args.has('--write-baseline');
  const enforce = args.has('--enforce');
  const enforceThreshold = 5; // percent

  const report = {
    generatedAt: new Date().toISOString(),
    measurements,
    totals: { raw: totalRaw, gz: totalGz, br: totalBr },
  };

  // Print human-readable
  console.log('\nBundle measurement\n==================');
  for (const m of measurements) {
    const prev = baseline?.measurements?.find(x => x.name === m.name);
    console.log(
      `  ${m.name}: ${m.fileCount} files | ` +
        `raw ${formatBytes(m.raw)} (${pct(prev?.raw, m.raw)}) | ` +
        `gz ${formatBytes(m.gz)} (${pct(prev?.gz, m.gz)}) | ` +
        `br ${formatBytes(m.br)} (${pct(prev?.br, m.br)})`
    );
  }
  console.log(
    `\n  TOTAL: raw ${formatBytes(totalRaw)} | gz ${formatBytes(totalGz)} | br ${formatBytes(totalBr)}\n`
  );

  if (updateBaseline) {
    await fs.writeFile(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`✓ Wrote baseline to ${path.relative(repoRoot, BASELINE_PATH)}\n`);
    return;
  }

  if (enforce) {
    if (!baseline) {
      console.error(
        '  ⚠️  --enforce specified but no .bundle-baseline.json exists. Run with --write-baseline first.'
      );
      process.exit(1);
    }
    const failures = [];
    for (const measurement of measurements) {
      const previous = baseline.measurements?.find(item => item.name === measurement.name);
      if (previous === undefined) {
        failures.push(`${measurement.name} has no approved baseline`);
        continue;
      }
      const delta =
        previous.gz === 0 ? Infinity : ((measurement.gz - previous.gz) / previous.gz) * 100;
      if (delta > enforceThreshold) {
        failures.push(`${measurement.name} grew ${delta.toFixed(1)}% gzipped`);
      }
    }
    const gzDelta =
      baseline.totals.gz === 0
        ? Infinity
        : ((totalGz - baseline.totals.gz) / baseline.totals.gz) * 100;
    if (gzDelta > enforceThreshold)
      failures.push(`aggregate artifacts grew ${gzDelta.toFixed(1)}% gzipped`);
    if (failures.length > 0) {
      console.error(`  ❌ Per-entrypoint bundle budget failed (threshold ${enforceThreshold}%):`);
      for (const failure of failures) console.error(`     - ${failure}`);
      process.exit(1);
    }
    console.log(
      `  ✓ Bundle within ${enforceThreshold}% of baseline (${gzDelta.toFixed(1)}% delta).\n`
    );
  }

  // Always emit JSON for CI consumption
  if (args.has('--json')) {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(err => {
  console.error('measure-bundle.js failed:', err);
  process.exit(1);
});
