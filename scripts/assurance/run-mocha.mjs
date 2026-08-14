import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const suiteName = process.argv[2];
const suites = {
  'domain-oracle': [
    'out/test/assurance/DomainOracle.examples.test.js'
  ],
  pbt: [
    'out/test/assurance/DomainOracle.property.test.js'
  ],
  contracts: [
    'out/test/assurance/ExternalBoundary.contract.test.js'
  ],
  'failure-injection': [
    'out/test/assurance/FailureInjection.integration.test.js'
  ]
};

if (!Object.hasOwn(suites, suiteName)) {
  console.error(`Unknown assurance suite: ${suiteName ?? '(missing)'}`);
  process.exit(2);
}

const testFiles = suites[suiteName].map(file => path.join(repoRoot, file));
for (const file of testFiles) {
  try {
    await fs.access(file);
  } catch {
    console.error(`${path.relative(repoRoot, file)} not found. Run npm run compile first.`);
    process.exit(2);
  }
}

const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
  repoRoot,
  '.kiro',
  'specs',
  'domain-verification-assurance',
  'evidence',
  'runs',
  'latest'
);
await fs.mkdir(evidenceRoot, { recursive: true });

const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
const shim = path.join(repoRoot, 'scripts', 'vscode-shim.cjs');
const timeoutMs = process.env.OTAK_PROXY_TEST_FAST === '1' ? 60_000 : 120_000;
const command = [mochaBin, '--ui', 'tdd', '--require', shim, '--exit', '--timeout', String(timeoutMs), ...testFiles];
const startedAt = new Date().toISOString();
const child = spawnSync(process.execPath, command, {
  cwd: repoRoot,
  env: {
    ...process.env,
    OTAK_PROXY_ASSURANCE_EVIDENCE_DIR: evidenceRoot,
    OTAK_PROXY_LOG_SILENT: process.env.OTAK_PROXY_LOG_SILENT ?? '1'
  },
  stdio: 'inherit'
});
const completedAt = new Date().toISOString();
const commandRecord = {
  schemaVersion: 1,
  suite: suiteName,
  startedAt,
  completedAt,
  command: [process.execPath, ...command.map(value => path.relative(repoRoot, value) || value)],
  exitCode: child.status ?? 1,
  signal: child.signal ?? null,
  host: os.hostname()
};
const recordPath = path.join(evidenceRoot, `command-${suiteName}.json`);
const temporaryPath = `${recordPath}.${process.pid}.tmp`;
await fs.writeFile(temporaryPath, `${JSON.stringify(commandRecord, null, 2)}\n`, 'utf8');
await fs.rename(temporaryPath, recordPath);
process.exit(child.status ?? 1);
