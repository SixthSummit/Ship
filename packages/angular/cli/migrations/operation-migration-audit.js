import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listMigrationSourceFiles, toPosix } from './migration-source-files.js';

const rules = [
  rule(
    'copied-api-client-import',
    'legacy-client',
    'high',
    /import[\s\S]*?from\s+['"][^'"]*lib\/core\/api\/client\/ApiClient['"]/g,
    'Replace the copied message-only client domain by domain; preserve it only behind the legacy REST adapter while each operation is characterized.'
  ),
  rule(
    'legacy-api-call',
    'operation-mapping',
    'high',
    /\b(?:this\s*\.\s*)?(?:api|apiClient)\s*\.\s*(?:delete|get|patch|post|put|request)\b/g,
    'Map the URL call to a generated stable operation ID and review input locations, declared errors, status handling, cancellation, and retry safety.'
  ),
  rule(
    'hono-route-client',
    'operation-mapping',
    'high',
    /(?:from\s+['"]hono\/client['"]|\bhc\s*(?:<[^;()]*?>\s*)?\(|\.\$(?:delete|get|patch|post|put)\s*\()/g,
    'Keep this call behind the /hono-v4 adapter until its route-tree mapping is replaced by a generated operation ID.'
  ),
  rule(
    'legacy-resource',
    'reactive',
    'high',
    /\bcreateResource\s*(?:<[^;()]*?>\s*)?\(/g,
    'Choose createOperationResource for reads or createOperationMutation for writes; review expected-result handling and cancellation explicitly.'
  ),
  rule(
    'legacy-shipapi-provider',
    'provider',
    'high',
    /\b(?:inject|provide)ShipApiClient\b/g,
    'Generate the app-owned structural client boundary and replace the Hono-specific provider at application configuration.'
  ),
  rule(
    'message-based-error-branch',
    'errors',
    'high',
    /(?:\.message\s*\.\s*(?:includes|indexOf|match|startsWith)\s*\(|String\s*\([^)]*(?:error|err)[^)]*\)\s*\.\s*(?:includes|match)\s*\()/gi,
    'Switch on the durable declared error code and retain status, details, request ID, metadata, and exceptional transport/protocol errors.'
  ),
  rule(
    'message-only-error',
    'errors',
    'high',
    /(?:throw\s+new\s+Error\s*\(\s*(?:error|err)(?:\.message)?\s*\)|Promise\.reject\s*\(\s*(?:error|err)(?:\.message)?\s*\))/gi,
    'Do not recreate the current message-only failure boundary; preserve the original typed result or exceptional error.'
  ),
  rule(
    'server-schema-import',
    'forms',
    'high',
    /from\s+['"][^'"]*(?:drizzle(?:-orm|-zod)?|\/server\/|ship-api\/src|database\/schemas?)[^'"]*['"]/gi,
    'Replace server/runtime schema imports with generated browser-safe form bindings from the packed contract boundary.'
  ),
  rule(
    'manual-bearer-header',
    'auth',
    'high',
    /(?:['"]?authorization['"]?\s*[:=]\s*[`'"]Bearer\b|\.set\s*\(\s*['"]Authorization['"]\s*,\s*[`'"]Bearer\b)/gi,
    'Use the shared credential capability so every attempt reads a current token and origin policy prevents credential leakage.'
  ),
  rule(
    'credentials-enabled',
    'auth',
    'medium',
    /\bwithCredentials\s*:\s*true\b|\bcredentials\s*:\s*['"](?:include|same-origin)['"]/g,
    'Classify this call as cookie, bearer, or intentionally mixed compatibility behavior before selecting credentials mode and CSRF policy.'
  ),
  rule(
    'direct-http-client',
    'third-party-rest',
    'medium',
    /import\s*\{[^}]*\bHttpClient\b[^}]*\}\s*from\s*['"]@angular\/common\/http['"]/g,
    'Classify each call as ShipAPI or independent third-party REST. Third-party calls may stay on HttpClient; ShipAPI calls move to the operation boundary.'
  ),
  rule(
    'custom-request-policy',
    'request-policy',
    'medium',
    /\b(?:HttpInterceptorFn|withInterceptors|withCsrf|withIdempotency|withRateLimit|withRequestId)\b/g,
    'Inventory policy behavior and move ShipAPI concerns to the shared operation request policy without changing independent HttpClient behavior.'
  ),
  rule(
    'multipart-transport',
    'transport',
    'medium',
    /\bnew\s+FormData\s*\(/g,
    'Migrate this call through a generated upload binding and the /upload capability; preserve field names, limits, progress, auth, errors, and abort.'
  ),
  rule(
    'binary-transport',
    'transport',
    'medium',
    /\bresponseType\s*:\s*['"](?:arraybuffer|blob)['"]/gi,
    'Migrate this call through the /download capability and preserve exact bytes, MIME type, disposition, filename, metadata, JSON errors, and abort.'
  ),
  rule(
    'stream-transport',
    'transport',
    'medium',
    /\b(?:EventSource|createStream)\s*(?:<[^;()]*?>\s*)?\(/g,
    'Use the generated stream binding and review event decoding, IDs, reconnect permission, pre-stream errors, cancellation, and completion.'
  ),
  rule(
    'socket-transport',
    'transport',
    'medium',
    /\b(?:WebSocket|createSocket)\s*(?:<[^;()]*?>\s*)?\(/g,
    'Use the generated socket binding and review subprotocol, message codecs, close policy, bounded buffering, reconnect credentials, and SSR inertness.'
  ),
  rule(
    'custom-serializer',
    'serialization',
    'medium',
    /\b(?:HttpParams|URLSearchParams)\s*\(|\bJSON\.stringify\s*\(/g,
    'Compare this serializer with generated path/query/header/body codecs; do not reproduce backend serialization rules in the Angular layer.'
  ),
  rule(
    'optimistic-state',
    'mutation',
    'medium',
    /\b(?:optimistic|rollback|reconcile)\b/gi,
    'Review apply, rollback, and reconcile behavior before moving this call to createOperationMutation.'
  ),
  rule(
    'constructor-http-di',
    'angular',
    'low',
    /\bconstructor\s*\([^)]*\b(?:ApiClient|HttpClient)\b[^)]*\)/g,
    'Convert dependency injection to inject() independently of operation mapping so the mechanical Angular change stays reviewable.'
  ),
];

export async function auditOperationMigration(rootDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  await assertDirectory(root);
  const files = await listMigrationSourceFiles(root, {
    includeTests: options.includeTests ?? false,
  });
  const findings = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relativeFile = toPosix(path.relative(root, file));
    const searchable = stripComments(source);
    for (const definition of rules) {
      const matches = [...searchable.matchAll(definition.expression)];
      if (matches.length === 0) continue;
      findings.push({
        code: definition.code,
        category: definition.category,
        risk: definition.risk,
        file: relativeFile,
        line: lineAt(searchable, matches[0].index ?? 0),
        occurrences: matches.length,
        recommendation: definition.recommendation,
      });
    }
  }

  const copiedFiles = files.filter(file =>
    toPosix(path.relative(root, file)).includes('src/app/lib/core/')
  );
  if (copiedFiles.length > 0) {
    findings.push({
      code: 'copied-framework-source',
      category: 'copied-code',
      risk: 'high',
      file: 'src/app/lib/core',
      line: 1,
      occurrences: copiedFiles.length,
      recommendation:
        'Record local changes and ownership, replace framework copies with pinned packages, and retain the old tree only as a recoverable rollback artifact.',
    });
  }

  findings.sort(compareFindings);
  return {
    schemaVersion: 1,
    scannedFiles: files.length,
    summary: summarize(findings),
    findings,
  };
}

export function renderMigrationAudit(report) {
  const lines = [
    'ShipAngular operation migration audit',
    `Scanned files: ${report.scannedFiles}`,
    `Review locations: ${report.summary.locations}`,
    `Occurrences: ${report.summary.occurrences}`,
    `Risk: ${report.summary.risk.high} high, ${report.summary.risk.medium} medium, ${report.summary.risk.low} low`,
  ];

  if (report.findings.length === 0) {
    lines.push(
      '',
      'No known migration patterns were found. Review dynamic or generated code manually.'
    );
    return `${lines.join('\n')}\n`;
  }

  let category;
  for (const finding of report.findings) {
    if (finding.category !== category) {
      category = finding.category;
      lines.push('', category);
    }
    lines.push(
      `  [${finding.risk.toUpperCase()}] ${finding.code} — ${finding.file}:${finding.line} (${finding.occurrences})`,
      `    ${finding.recommendation}`
    );
  }
  lines.push(
    '',
    'This report is intentionally non-mutating. Stable operation IDs, input mappings, declared errors, retry safety, and transport metadata must come from the packed ShipAPI contract before code is rewritten.'
  );
  return `${lines.join('\n')}\n`;
}

export async function writeMigrationAudit(file, contents, options = {}) {
  const target = path.resolve(file);
  if (!options.force && (await exists(target))) {
    throw new Error(`Refusing to overwrite existing migration report: ${target}`);
  }
  await writeFile(target, contents, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });
  return target;
}

function rule(code, category, risk, expression, recommendation) {
  return { code, category, risk, expression, recommendation };
}

function summarize(findings) {
  const summary = {
    locations: findings.length,
    occurrences: 0,
    risk: { high: 0, medium: 0, low: 0 },
    categories: {},
  };
  for (const finding of findings) {
    summary.occurrences += finding.occurrences;
    summary.risk[finding.risk] += finding.occurrences;
    summary.categories[finding.category] =
      (summary.categories[finding.category] ?? 0) + finding.occurrences;
  }
  return summary;
}

function compareFindings(left, right) {
  const riskOrder = { high: 0, medium: 1, low: 2 };
  return (
    riskOrder[left.risk] - riskOrder[right.risk] ||
    left.category.localeCompare(right.category) ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.code.localeCompare(right.code)
  );
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gm, match => match.replace(/[^\n]/g, ' '));
}

async function assertDirectory(directory) {
  try {
    const entries = await readdir(directory);
    if (!Array.isArray(entries)) throw new Error();
  } catch {
    throw new Error(`Migration audit directory does not exist or is not readable: ${directory}`);
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
