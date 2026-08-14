import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const formalRoot = path.join(repoRoot, 'formal');
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
  repoRoot, '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'runs', 'latest'
);
const tlcCommand = process.env.OTAK_PROXY_TLC_CMD ?? path.join(
  process.env.LOCALAPPDATA ?? '', 'Programs', 'TLAplus', 'tlc.cmd'
);
const timeoutMs = Number(process.env.OTAK_PROXY_TLC_TIMEOUT_MS ?? 120_000);
const workerCount = '1';
const fingerprintPolynomial = '0';
const runs = [
  {
    id: 'TLC-LIFECYCLE-SMALL',
    spec: 'ProxyLifecycle',
    config: 'ProxyLifecycle.small.cfg',
    seed: 2026081501,
    expected: { kind: 'success' },
    purpose: 'Safety/Liveness/deadlock: actor=1, retry=0, time=0, resource=1, epoch=2',
    constraints: 'bounded actors, retries, logical time, resources, and cancellation epochs'
  },
  {
    id: 'TLC-LIFECYCLE-MEDIUM',
    spec: 'ProxyLifecycle',
    config: 'ProxyLifecycle.medium.cfg',
    seed: 2026081502,
    expected: { kind: 'success' },
    purpose: 'Safety/Liveness/deadlock: actor=2, retry=1, time=2, resource=1, epoch=2',
    constraints: 'bounded actors, retries, logical time, resources, and cancellation epochs'
  },
  {
    id: 'TLC-LIFECYCLE-REQUIRED-APPLIED',
    spec: 'ProxyLifecycle',
    config: 'ProxyLifecycle.reachability.cfg',
    seed: 2026081503,
    expected: { kind: 'invariant-violation', invariant: 'NeverApplied' },
    purpose: 'Required-state reachability: an applied terminal state must be discoverable.',
    constraints: 'same finite lifecycle abstraction; expected counterexample proves reachability'
  },
  {
    id: 'TLC-SYNC-RELIABLE-SMALL',
    spec: 'SyncConvergence',
    config: 'SyncConvergence.reliable-small.cfg',
    seed: 2026081511,
    expected: { kind: 'success' },
    purpose: 'Safety/Liveness/deadlock under reliable delivery: actor=2, clock=2, queue=2, drops=0',
    constraints: 'finite logical clocks/queues; arbitrary delivery order and duplicate messages'
  },
  {
    id: 'TLC-SYNC-RELIABLE-MEDIUM',
    spec: 'SyncConvergence',
    config: 'SyncConvergence.reliable-medium.cfg',
    seed: 2026081512,
    expected: { kind: 'success' },
    purpose: 'Safety/Liveness/deadlock under reliable delivery: actor=3, clock=2, queue=2, drops=0',
    constraints: 'finite logical clocks/queues; arbitrary delivery order and duplicate messages'
  },
  {
    id: 'TLC-SYNC-LOSS-BOUNDARY',
    spec: 'SyncConvergence',
    config: 'SyncConvergence.loss-boundary.cfg',
    seed: 2026081513,
    expected: { kind: 'invariant-violation', invariant: 'ConvergedWhenQuiescent' },
    purpose: 'Forbidden-state reachability after relaxing reliable-delivery assumption with one dropped message.',
    constraints: 'expected counterexample proves why MaxDrops=0 is a liveness/safety environment assumption'
  },
  {
    id: 'TLC-SYNC-DIVERGENCE-REACHABILITY',
    spec: 'SyncConvergence',
    config: 'SyncConvergence.reachability.cfg',
    seed: 2026081514,
    expected: { kind: 'invariant-violation', invariant: 'NeverPublishedDivergence' },
    purpose: 'Required transient-state reachability: publish is observable before convergence.',
    constraints: 'expected counterexample proves adversarial ordering is represented'
  }
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function latestMatch(text, expression) {
  const matches = [...text.matchAll(expression)];
  return matches.length === 0 ? undefined : matches.at(-1);
}

function count(value) {
  return Number(String(value).replace(/,/gu, ''));
}

function parseTlcOutput(output) {
  const stateMatch = latestMatch(output, /(\d[\d,]*) states generated, (\d[\d,]*) distinct states found, (\d[\d,]*) states left on queue\./gu);
  const diameterMatch = latestMatch(output, /The depth of the complete state graph search is (\d+)\./gu);
  const versionMatch = output.match(/TLC2 Version ([^\r\n]+)/u);
  const seedMatch = output.match(/with fp \d+ and seed (-?\d+)/u);
  const runtimeMatch = output.match(/with (\d+) worker(?:s)? on (\d+) cores with (\d+)MB heap and (\d+)MB offheap memory \[pid: \d+\] \(([^,]+), ([^,]+),/u);
  const elapsedMatch = latestMatch(output, /Finished in ([^\s]+) at \([^\r\n]+\)/gu);
  return {
    version: versionMatch?.[1] ?? null,
    seedObserved: seedMatch?.[1] ?? null,
    runtime: runtimeMatch ? {
      workersObserved: Number(runtimeMatch[1]),
      coresObserved: Number(runtimeMatch[2]),
      heapMb: Number(runtimeMatch[3]),
      offheapMb: Number(runtimeMatch[4]),
      platform: runtimeMatch[5],
      java: runtimeMatch[6]
    } : null,
    generatedStates: stateMatch ? count(stateMatch[1]) : null,
    distinctStates: stateMatch ? count(stateMatch[2]) : null,
    statesLeftOnQueue: stateMatch ? count(stateMatch[3]) : null,
    diameter: diameterMatch ? Number(diameterMatch[1]) : null,
    elapsed: elapsedMatch?.[1] ?? null,
    deadlockDetected: /Deadlock reached/u.test(output),
    completedWithoutError: /Model checking completed\. No error has been found\./u.test(output),
    traceProduced: /The behavior up to this point is:/u.test(output)
  };
}

function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9_:.~\\/-]+$/u.test(text)) {
    throw new Error(`Unsafe Windows command argument: ${text}`);
  }
  return text;
}

function invokeTlc(args, options) {
  if (process.platform !== 'win32') {
    return spawnSync(tlcCommand, args, options);
  }
  const commandLine = [tlcCommand, ...args].map(quoteWindowsCommandArgument).join(' ');
  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', commandLine], options);
}

async function runModel(run) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otak-proxy-tlc-'));
  const startedAt = new Date().toISOString();
  try {
    const specPath = path.join(formalRoot, `${run.spec}.tla`);
    const configPath = path.join(formalRoot, run.config);
    const [specSource, configSource] = await Promise.all([
      fs.readFile(specPath, 'utf8'),
      fs.readFile(configPath, 'utf8')
    ]);
    const args = [
      '-config', configPath,
      '-metadir', path.join(temporaryRoot, 'states'),
      '-workers', workerCount,
      '-fp', fingerprintPolynomial,
      '-seed', String(run.seed),
      run.spec
    ];
    const child = invokeTlc(args, {
      cwd: formalRoot,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    const parsed = parseTlcOutput(output);
    const timedOut = child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM';
    const expectedViolation = run.expected.kind === 'invariant-violation';
    const violationText = expectedViolation
      ? new RegExp(`Invariant ${run.expected.invariant} is violated\\.`, 'u').test(output)
      : false;
    const passed = expectedViolation
      ? violationText && parsed.traceProduced && !timedOut
      : child.status === 0 && parsed.completedWithoutError && !parsed.deadlockDetected && !timedOut;
    return {
      ...run,
      status: passed ? 'passed' : 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      command: [tlcCommand, ...args],
      exitCode: child.status ?? null,
      signal: child.signal ?? null,
      error: child.error?.message ?? null,
      timedOut,
      source: {
        spec: path.relative(repoRoot, specPath),
        specSha256: sha256(specSource),
        config: path.relative(repoRoot, configPath),
        configSha256: sha256(configSource)
      },
      exploration: {
        method: 'TLC breadth-first exhaustive state-graph exploration within configured finite bounds',
        workers: Number(workerCount),
        fingerprintPolynomial: Number(fingerprintPolynomial),
        requestedSeed: run.seed,
        ...parsed,
        timeoutMs,
        unexplored: 'actor count, logical time, epoch, retry count, queue depth, resource capacity, and drop budget outside the .cfg constants; real wall-clock, OS scheduling, network and filesystem protocol details'
      },
      output
    };
  } catch (error) {
    return {
      ...run,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      exploration: {
        method: 'not started',
        requestedSeed: run.seed,
        timeoutMs
      },
      output: ''
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await fs.access(tlcCommand);
} catch {
  throw new Error(`TLC command not found: ${tlcCommand}. Set OTAK_PROXY_TLC_CMD to tlc.cmd.`);
}

const results = [];
for (const run of runs) {
  process.stdout.write(`TLC ${run.id}... `);
  const result = await runModel(run);
  results.push(result);
  console.log(result.status);
}

await fs.mkdir(path.join(evidenceRoot, 'tla'), { recursive: true });
for (const result of results) {
  await fs.writeFile(path.join(evidenceRoot, 'tla', `${result.id}.log`), result.output, 'utf8');
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  tool: {
    name: 'TLA+ TLC',
    command: tlcCommand,
    requestedWorkers: Number(workerCount),
    fingerprintPolynomial: Number(fingerprintPolynomial)
  },
  allPassed: results.every(result => result.status === 'passed'),
  runs: results.map(({ output, ...result }) => result)
};
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(path.join(evidenceRoot, 'tla.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const markdown = [
  '# TLC Result',
  '',
  `- TLC command: ${report.tool.command}`,
  `- Exploration: breadth-first, workers=${workerCount}, fp=${fingerprintPolynomial}; each run uses its recorded fixed seed.`,
  `- All expected outcomes passed: ${report.allPassed}`,
  '',
  '| Run | Expected | Result | Seed | Generated / distinct | Diameter | Deadlock |',
  '| --- | --- | --- | ---: | ---: | ---: | --- |',
  ...report.runs.map(result => {
    const expected = result.expected.kind === 'success'
      ? 'Safety/Liveness/deadlock pass'
      : `Expected ${result.expected.invariant} trace`;
    const states = result.exploration.generatedStates === null
      ? 'n/a'
      : `${result.exploration.generatedStates} / ${result.exploration.distinctStates}`;
    return `| ${result.id} | ${expected} | ${result.status} | ${result.exploration.seedObserved ?? result.seed} | ${states} | ${result.exploration.diameter ?? 'n/a'} | ${result.exploration.deadlockDetected ?? 'n/a'} |`;
  })
].join('\n');
await fs.writeFile(path.join(evidenceRoot, 'tla.md'), `${markdown}\n`, 'utf8');
console.log(`tlc-runs=${results.length} passed=${results.filter(result => result.status === 'passed').length}`);
if (!report.allPassed) process.exitCode = 1;
