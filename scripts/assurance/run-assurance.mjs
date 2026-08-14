import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
  repoRoot,
  '.kiro',
  'specs',
  'domain-verification-assurance',
  'evidence',
  'runs',
  'latest'
);
const commandTimeoutMs = Number(process.env.OTAK_PROXY_ASSURANCE_COMMAND_TIMEOUT_MS ?? 360_000);
const cleanupScript = path.join(repoRoot, 'scripts', 'assurance', 'cleanup-test-processes.mjs');
const auditScript = path.join(repoRoot, 'scripts', 'assurance', 'run-adversarial-audit.mjs');

if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs <= 0) {
  throw new Error('OTAK_PROXY_ASSURANCE_COMMAND_TIMEOUT_MS must be a positive number');
}

async function firstReadable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next known npm-cli location.
    }
  }
  throw new Error('npm-cli.js could not be located; invoke this script through npm or set npm_execpath.');
}

const npmCli = await firstReadable([
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
]);

const checks = [
  { id: 'lint', npmArgs: ['run', 'lint'], testProcess: false },
  { id: 'unit', npmArgs: ['run', 'test:unit'], testProcess: true },
  { id: 'vscode-host', npmArgs: ['test'], testProcess: true },
  { id: 'domain-oracle', npmArgs: ['run', 'test:domain-oracle'], testProcess: true },
  { id: 'pbt-replay', npmArgs: ['run', 'test:pbt:replay'], testProcess: true },
  { id: 'contracts', npmArgs: ['run', 'test:contracts'], testProcess: true },
  { id: 'failure-injection', npmArgs: ['run', 'test:failure-injection'], testProcess: true },
  { id: 'c2', npmArgs: ['run', 'coverage:c2'], testProcess: true },
  { id: 'mutation', npmArgs: ['run', 'mutation:domain'], testProcess: true },
  { id: 'tla', npmArgs: ['run', 'verify:tla'], testProcess: false },
  { id: 'traceability', npmArgs: ['run', 'verify:traceability'], testProcess: false }
];

function runProcess(id, command, args, timeoutMs) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      OTAK_PROXY_ASSURANCE_EVIDENCE_DIR: evidenceRoot,
      OTAK_PROXY_LOG_SILENT: process.env.OTAK_PROXY_LOG_SILENT ?? '1'
    },
    stdio: 'inherit',
    timeout: timeoutMs
  });
  return {
    id,
    startedAt,
    completedAt: new Date().toISOString(),
    command: [command, ...args],
    timeoutMs,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    error: result.error ? String(result.error.message) : null,
    passed: result.status === 0 && !result.error
  };
}

async function writeAtomically(fileName, value) {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const destination = path.join(evidenceRoot, fileName);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, destination);
}

const results = [];
for (const check of checks) {
  console.log(`\n=== assurance:${check.id} ===`);
  results.push(runProcess(check.id, process.execPath, [npmCli, ...check.npmArgs], commandTimeoutMs));
  if (check.testProcess) {
    console.log(`=== assurance:${check.id}:process-cleanup ===`);
    results.push(runProcess(`${check.id}:process-cleanup`, process.execPath, [cleanupScript], 60_000));
  }
}

console.log('\n=== assurance:final-process-cleanup ===');
results.push(runProcess('final-process-cleanup', process.execPath, [cleanupScript], 60_000));

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: os.hostname(),
  node: process.version,
  npmCli: path.relative(repoRoot, npmCli),
  evidenceRoot: path.relative(repoRoot, evidenceRoot),
  commandTimeoutMs,
  checks: results,
  failedChecks: results.filter(result => !result.passed).map(result => result.id),
  allPassed: results.every(result => result.passed)
};
await writeAtomically('assurance-run.json', report);

console.log('\n=== assurance:adversarial-audit ===');
const audit = runProcess('adversarial-audit', process.execPath, [auditScript], 60_000);
report.checks.push(audit);
report.failedChecks = results.filter(result => !result.passed).map(result => result.id);
await writeAtomically('assurance-run.json', report);

console.log(`assurance-run all-passed=${report.allPassed} failed=${report.failedChecks.length}`);
if (!report.allPassed) process.exitCode = 1;
