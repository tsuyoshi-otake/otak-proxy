import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
  repoRoot, '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'runs', 'latest'
);
const scopePath = path.join(
  repoRoot, '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'manifests', 'mutation-scope.json'
);
const hook = path.join(repoRoot, 'scripts', 'assurance', 'mutation-hook.cjs');
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
const shim = path.join(repoRoot, 'scripts', 'vscode-shim.cjs');
const testFiles = [
  'out/test/assurance/DomainOracle.examples.test.js',
  'out/test/assurance/DomainOracle.property.test.js',
  'out/test/assurance/ExternalBoundary.contract.test.js',
  'out/test/assurance/FailureInjection.integration.test.js'
].map(file => path.join(repoRoot, file));
const timeoutMs = Number(process.env.OTAK_PROXY_MUTATION_TIMEOUT_MS ?? 60_000);
const scopeSource = await fs.readFile(scopePath, 'utf8');
const scope = JSON.parse(scopeSource);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function redact(value) {
  return String(value)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gu, '$1[REDACTED]@')
    .replace(/(token|secret|password)=([^\s&]+)/giu, '$1=[REDACTED]');
}

function tail(value, maximum = 4000) {
  const text = redact(value ?? '');
  return text.length <= maximum ? text : text.slice(-maximum);
}

function compiledPath(source) {
  return source.replace(/^src[\\/]/u, 'out/').replace(/\.ts$/u, '.js');
}

function applyExactMutation(source, mutant) {
  const first = source.indexOf(mutant.from);
  if (first < 0) {
    throw new Error(`${mutant.id}: source fragment not found: ${mutant.from}`);
  }
  if (source.indexOf(mutant.from, first + mutant.from.length) >= 0) {
    throw new Error(`${mutant.id}: source fragment is ambiguous: ${mutant.from}`);
  }
  return `${source.slice(0, first)}${mutant.to}${source.slice(first + mutant.from.length)}`;
}

async function executeMutant(mutant) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-mutation-'));
  const startedAt = new Date().toISOString();
  try {
    const sourcePath = path.join(repoRoot, mutant.source);
    const source = await fs.readFile(sourcePath, 'utf8');
    const compiled = await fs.readFile(path.join(repoRoot, compiledPath(mutant.source)), 'utf8');
    const mutated = applyExactMutation(compiled, mutant);
    const mutatedPath = path.join(tempRoot, compiledPath(mutant.source));
    await fs.mkdir(path.dirname(mutatedPath), { recursive: true });
    await fs.writeFile(mutatedPath, mutated, 'utf8');
    const syntax = spawnSync(process.execPath, ['--check', mutatedPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000
    });
    if (syntax.status !== 0) {
      return {
        id: mutant.id,
        source: mutant.source,
        sourceSha256: sha256(source),
        compiledPath: compiledPath(mutant.source),
        operator: mutant.operator,
        from: mutant.from,
        to: mutant.to,
        requirements: mutant.requirements,
        tests: mutant.tests,
        equivalence: mutant.equivalence,
        status: 'compile-error',
        loaded: false,
        exitCode: syntax.status ?? null,
        signal: syntax.signal ?? null,
        error: syntax.error ? redact(syntax.error.message) : null,
        stdoutTail: tail(syntax.stdout),
        stderrTail: tail(syntax.stderr),
        startedAt,
        completedAt: new Date().toISOString()
      };
    }
    const temporaryEvidence = path.join(tempRoot, 'evidence');
    const loadedMarker = path.join(tempRoot, 'loaded.json');
    await fs.mkdir(temporaryEvidence, { recursive: true });
    const nodeOptions = [process.env.NODE_OPTIONS, `--require=${hook}`].filter(Boolean).join(' ');
    const command = [
      mochaBin, '--ui', 'tdd', '--require', shim, '--exit', '--timeout', String(timeoutMs), ...testFiles
    ];
    const child = spawnSync(process.execPath, command, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: timeoutMs + 5_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        OTAK_PROXY_ASSURANCE_EVIDENCE_DIR: temporaryEvidence,
        OTAK_PROXY_LOG_SILENT: process.env.OTAK_PROXY_LOG_SILENT ?? '1',
        OTAK_PROXY_MUTATION_DIR: tempRoot,
        OTAK_PROXY_MUTATION_REPO: repoRoot,
        OTAK_PROXY_MUTATION_LOADED: loadedMarker,
        OTAK_PROXY_TEST_FAST: process.env.OTAK_PROXY_TEST_FAST ?? '1'
      }
    });
    const timedOut = child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM';
    const loaded = await fs.access(loadedMarker).then(() => true).catch(() => false);
    const status = timedOut
      ? 'timeout'
      : !loaded && child.status === 0
        ? 'no-coverage'
        : !loaded
          ? 'invalid'
          : child.status === 0
            ? 'survived'
            : 'killed';
    return {
      id: mutant.id,
      source: mutant.source,
      sourceSha256: sha256(source),
      compiledPath: compiledPath(mutant.source),
      operator: mutant.operator,
      from: mutant.from,
      to: mutant.to,
      requirements: mutant.requirements,
      tests: mutant.tests,
      equivalence: mutant.equivalence,
      status,
      loaded,
      exitCode: child.status ?? null,
      signal: child.signal ?? null,
      error: child.error ? redact(child.error.message) : null,
      stdoutTail: tail(child.stdout),
      stderrTail: tail(child.stderr),
      startedAt,
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      id: mutant.id,
      source: mutant.source,
      operator: mutant.operator,
      from: mutant.from,
      to: mutant.to,
      requirements: mutant.requirements,
      tests: mutant.tests,
      equivalence: mutant.equivalence,
      status: 'invalid',
      loaded: false,
      exitCode: null,
      signal: null,
      error: redact(error instanceof Error ? error.message : String(error)),
      stdoutTail: '',
      stderrTail: '',
      startedAt,
      completedAt: new Date().toISOString()
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const results = [];
for (const mutant of scope.mutants) {
  process.stdout.write(`mutation ${mutant.id}... `);
  const result = await executeMutant(mutant);
  results.push(result);
  console.log(result.status);
}

const equivalent = results.filter(result => result.status === 'survived' && result.equivalence);
for (const result of equivalent) result.status = 'equivalent';
const scorable = results.filter(result => result.status !== 'equivalent');
const killed = results.filter(result => result.status === 'killed');
const survived = results.filter(result => result.status === 'survived');
const timeouts = results.filter(result => result.status === 'timeout');
const noCoverage = results.filter(result => result.status === 'no-coverage');
const compileErrors = results.filter(result => result.status === 'compile-error');
const ignored = results.filter(result => result.status === 'ignored');
const invalid = results.filter(result => result.status === 'invalid');
const rawMutationScore = results.length === 0 ? 100 : (killed.length / results.length) * 100;
const adjustedMutationScore = scorable.length === 0 ? 100 : (killed.length / scorable.length) * 100;
const classificationCounts = Object.fromEntries(
  ['killed', 'survived', 'timeout', 'no-coverage', 'compile-error', 'ignored', 'equivalent', 'invalid']
    .map(status => [status, results.filter(result => result.status === status).length])
);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  tool: {
    ...scope.tool,
    node: process.version,
    timeoutMs,
    execution: 'one isolated compiled-output mutant per Node process',
    scopeSha256: sha256(scopeSource)
  },
  selectionRationale: scope.selectionRationale,
  tests: testFiles.map(file => path.relative(repoRoot, file)),
  command: [process.execPath, mochaBin, '--ui', 'tdd', '--require', shim, '--exit', '--timeout', String(timeoutMs), ...testFiles],
  totalMutants: results.length,
  classificationCounts,
  killed: killed.length,
  survived: survived.length,
  equivalent: equivalent.length,
  timeout: timeouts.length,
  noCoverage: noCoverage.length,
  compileError: compileErrors.length,
  ignored: ignored.length,
  unclassified: invalid.length,
  rawMutationScore,
  adjustedMutationScore,
  mutationScore: adjustedMutationScore,
  survivingMutants: survived,
  equivalentMutants: equivalent,
  timeoutMutants: timeouts,
  noCoverageMutants: noCoverage,
  compileErrorMutants: compileErrors,
  ignoredMutants: ignored,
  invalidMutants: invalid,
  survivorAnalysis: survived.map(result => ({
    id: result.id,
    requirements: result.requirements,
    change: `${result.from} -> ${result.to}`,
    reachableInput: '未確定。生存は追加の到達入力又は観測点が必要であることを示す。',
    observability: 'テスト実行は成功し、観測可能な差分が検出されなかった。',
    requiredAction: '対応する決定表・PBT・failure injectionを追加し、再度mutationを実行する。'
  })),
  mutants: results
};
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(path.join(evidenceRoot, 'mutation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const markdown = [
  '# Mutation Result',
  '',
  `- Tool: ${report.tool.name} v${report.tool.version} (Node ${report.tool.node})`,
  `- Scope: ${report.selectionRationale}`,
  `- Raw mutation score: ${report.rawMutationScore.toFixed(2)}% (${report.killed}/${report.totalMutants} total mutants killed)`,
  `- Adjusted mutation score: ${report.adjustedMutationScore.toFixed(2)}% (${report.killed}/${scorable.length} non-equivalent mutants killed)`,
  `- Surviving mutants: ${report.survived}`,
  `- Equivalent mutants: ${report.equivalent}`,
  `- Timeouts: ${report.timeout}; no coverage: ${report.noCoverage}; compile errors: ${report.compileError}; ignored: ${report.ignored}; unclassified: ${report.unclassified}`,
  '',
  '| Mutant | Operator | Status | Source | Test evidence | Equivalence analysis |',
  '| --- | --- | --- | --- | --- | --- |',
  ...results.map(result => `| ${result.id} | ${result.operator} | ${result.status} | ${result.source} | ${result.tests.join(', ')} | ${result.equivalence ?? 'None; behavior differs for a reachable input.'} |`)
].join('\n');
await fs.writeFile(path.join(evidenceRoot, 'mutation.md'), `${markdown}\n`, 'utf8');
console.log(`mutation-score=${adjustedMutationScore.toFixed(2)} killed=${killed.length} survived=${survived.length} equivalent=${equivalent.length}`);
if (survived.length > 0 || timeouts.length > 0 || noCoverage.length > 0 || compileErrors.length > 0 || invalid.length > 0 || adjustedMutationScore < 100) {
  process.exitCode = 1;
}
