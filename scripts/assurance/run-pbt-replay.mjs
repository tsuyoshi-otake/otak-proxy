import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const args = process.argv.slice(2);
const artifactIndex = args.indexOf('--artifact');
const fixtureIndex = args.indexOf('--fixture');

function runPbtSuite() {
  const runner = path.join(repoRoot, 'scripts', 'assurance', 'run-mocha.mjs');
  const result = spawnSync(process.execPath, [runner, 'pbt'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit'
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function newestCalibrationArtifact() {
  const root = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
    repoRoot,
    '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'runs', 'latest'
  );
  const directory = path.join(root, 'pbt');
  const names = await fs.readdir(directory);
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const artifactPath = path.join(directory, name);
    const value = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
    if (value.propertyId === 'PBT-CAL-001') candidates.push({ artifactPath, value });
  }
  candidates.sort((left, right) => left.value.runId.localeCompare(right.value.runId));
  if (candidates.length === 0) throw new Error('No PBT-CAL-001 artifact was found after the PBT run');
  return candidates.at(-1);
}

async function replayCalibration(artifactPath) {
  const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
  if (artifact.propertyId !== 'PBT-CAL-001') {
    throw new Error(`Only PBT-CAL-001 artifacts are replayable by this command; got ${artifact.propertyId}`);
  }
  if (artifact.status !== 'calibrated' || typeof artifact.seed !== 'number' || !artifact.path) {
    throw new Error('Calibration artifact lacks a status, seed, or replay path');
  }
  const fixtures = JSON.parse(await fs.readFile(path.join(
    repoRoot,
    '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'pbt', 'replay-fixtures.json'
  ), 'utf8'));
  if (artifact.generatorVersion !== fixtures.generatorVersions['PBT-CAL-001']) {
    throw new Error('Generator version mismatch; refusing an ambiguous replay');
  }

  const fc = require('fast-check');
  const { expectedActiveProxy } = require(path.join(repoRoot, 'out', 'test', 'assurance', 'oracle', 'DomainOracle.js'));
  const knownBadInput = fc.integer({ min: 2, max: 100 }).map(size => ({
    mode: 'auto',
    autoModeOff: true,
    autoProxyUrl: `safe://proxy/${'x'.repeat(size)}`
  }));
  const knownBadProperty = fc.property(knownBadInput, input => {
    const knownBadActual = input.autoProxyUrl ?? '';
    if (knownBadActual !== expectedActiveProxy(input).value) {
      throw new Error('auto-off-must-not-yield-an-active-url');
    }
  });
  const replay = fc.check(knownBadProperty, { seed: artifact.seed, path: artifact.path, numRuns: 1 });
  if (!replay.failed) throw new Error('Saved calibration artifact did not reproduce its failure');
  if (JSON.stringify(replay.counterexample) !== JSON.stringify(artifact.counterexample)) {
    throw new Error('Replay produced a different shrunk counterexample');
  }
  console.log(`Replayed ${artifact.propertyId}: ${artifactPath}`);
}

if (fixtureIndex !== -1) {
  const fixture = args[fixtureIndex + 1];
  if (fixture !== 'all') {
    console.error(`Unknown fixture set: ${fixture ?? '(missing)'}`);
    process.exit(2);
  }
  runPbtSuite();
  const calibration = await newestCalibrationArtifact();
  await replayCalibration(calibration.artifactPath);
} else if (artifactIndex !== -1 && args[artifactIndex + 1]) {
  await replayCalibration(path.resolve(repoRoot, args[artifactIndex + 1]));
} else {
  console.error('Usage: run-pbt-replay.mjs --fixture all | --artifact <pbt-record.json>');
  process.exit(2);
}
