import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-c2-'));
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
  repoRoot, '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'runs', 'latest'
);
const instrumentation = path.join(repoRoot, 'scripts', 'assurance', 'c2-instrument.mjs');
const hook = path.join(repoRoot, 'scripts', 'assurance', 'c2-hook.cjs');
const observationsPath = path.join(tempRoot, 'observations.json');
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
const shim = path.join(repoRoot, 'scripts', 'vscode-shim.cjs');

function invoke(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: repoRoot, env, stdio: 'inherit' });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

try {
  invoke(process.execPath, [instrumentation, '--out', tempRoot]);
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${hook}`].filter(Boolean).join(' ');
  invoke(process.execPath, [
    mochaBin,
    '--ui', 'tdd',
    '--require', shim,
    '--exit',
    '--timeout', process.env.OTAK_PROXY_TEST_FAST === '1' ? '60000' : '120000',
    path.join(repoRoot, 'out', 'test', 'assurance', 'DomainOracle.examples.test.js'),
    path.join(repoRoot, 'out', 'test', 'assurance', 'DomainOracle.property.test.js')
  ], {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    OTAK_PROXY_C2_DIR: tempRoot,
    OTAK_PROXY_C2_REPO: repoRoot,
    OTAK_PROXY_C2_OBSERVATIONS: observationsPath,
    OTAK_PROXY_ASSURANCE_EVIDENCE_DIR: evidenceRoot,
    OTAK_PROXY_LOG_SILENT: process.env.OTAK_PROXY_LOG_SILENT ?? '1'
  });

  const manifest = JSON.parse(await fs.readFile(path.join(tempRoot, 'manifest.json'), 'utf8'));
  const observationFile = JSON.parse(await fs.readFile(observationsPath, 'utf8'));
  const infeasible = new Map((manifest.infeasible ?? []).map(entry => [entry.id, entry]));
  const conditions = manifest.conditions.map(condition => {
    const observed = observationFile.observations[condition.id] ?? { trueCount: 0, falseCount: 0 };
    const isInfeasible = infeasible.has(condition.id);
    return {
      ...condition,
      trueCount: observed.trueCount,
      falseCount: observed.falseCount,
      unobservedCount: (observed.trueCount === 0 ? 1 : 0) + (observed.falseCount === 0 ? 1 : 0),
      feasible: !isInfeasible,
      infeasibility: isInfeasible ? infeasible.get(condition.id) : undefined
    };
  });
  const covered = conditions.filter(condition => condition.trueCount > 0 && condition.falseCount > 0).length;
  const feasibleConditions = conditions.filter(condition => condition.feasible);
  const feasibleCovered = feasibleConditions.filter(condition => condition.trueCount > 0 && condition.falseCount > 0).length;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    instrumentation: manifest.instrumentation,
    typescriptVersion: manifest.typescriptVersion,
    rawC2: conditions.length === 0 ? 0 : (covered / conditions.length) * 100,
    feasibleC2: feasibleConditions.length === 0 ? 100 : (feasibleCovered / feasibleConditions.length) * 100,
    totalConditions: conditions.length,
    feasibleConditions: feasibleConditions.length,
    unobserved: conditions.filter(condition => condition.unobservedCount > 0),
    conditions
  };
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(path.join(evidenceRoot, 'c2.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const markdown = [
    '# C2 Result',
    '',
    `- Raw C2: ${report.rawC2.toFixed(2)}% (${covered}/${conditions.length})`,
    `- Feasible C2: ${report.feasibleC2.toFixed(2)}% (${feasibleCovered}/${feasibleConditions.length})`,
    `- Unobserved atomic values: ${report.unobserved.reduce((count, condition) => count + condition.unobservedCount, 0)}`,
    '',
    '| Condition | True | False | Feasible | Expression |',
    '| --- | ---: | ---: | --- | --- |',
    ...conditions.map(condition => `| ${condition.id} | ${condition.trueCount} | ${condition.falseCount} | ${condition.feasible} | \`${condition.expression.replace(/`/gu, '\\`')}\` |`)
  ].join('\n');
  await fs.writeFile(path.join(evidenceRoot, 'c2.md'), `${markdown}\n`, 'utf8');
  console.log(`feasible-c2=${report.feasibleC2.toFixed(2)} (${feasibleCovered}/${feasibleConditions.length})`);
  if (report.feasibleC2 < 100) process.exitCode = 1;
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
