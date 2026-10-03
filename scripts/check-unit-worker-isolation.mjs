// Checks that the unit lane gives every mocha --parallel worker its own
// temporary directory, Git global config, and npm user config, so workers
// never share the Git config mutex (os.tmpdir()/otak-proxy.gitconfig.mutex),
// and that it leaves nothing behind in the system temporary directory (#103).
//
// Two probe files run under scripts/lib/unit-mocha.mjs with --parallel --jobs 2;
// each records what its worker sees. Run with `npm run test:unit:isolation`
// (the probes load the compiled GitConfigLocking module from out/). Do not run
// it next to another unit test run: it compares the otak-proxy-unit-*
// directories in the system temporary directory before and after.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUnitMocha } from './lib/unit-mocha.mjs';

const repoRoot = process.cwd();
if (!fs.existsSync(path.join(repoRoot, 'out', 'config', 'GitConfigLocking.js'))) {
  console.error('out/config/GitConfigLocking.js not found. Run `npm run compile` first.');
  process.exit(2);
}

const probeDir = path.join(repoRoot, 'scripts', 'fixtures', 'unit-isolation');
const probes = ['probe-a.cjs', 'probe-b.cjs'].map(name => path.join(probeDir, name));
const systemTmp = os.tmpdir();
const sharedMutex = path.join(systemTmp, 'otak-proxy.gitconfig.mutex');

function unitRunDirs() {
  return new Set(fs.readdirSync(systemTmp).filter(name => name.startsWith('otak-proxy-unit-')));
}

function isInside(dir, p) {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const before = unitRunDirs();
const reportDir = fs.mkdtempSync(path.join(systemTmp, 'otak-proxy-isolation-probe-'));
let status;
let reports = [];
try {
  process.env.OTAK_PROXY_ISOLATION_PROBE_OUT = reportDir;
  status = runUnitMocha(repoRoot, probes, { parallel: true, jobs: 2, timeoutMs: 30000 });
  reports = fs.readdirSync(reportDir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(reportDir, name), 'utf8')));
} finally {
  delete process.env.OTAK_PROXY_ISOLATION_PROBE_OUT;
  fs.rmSync(reportDir, { recursive: true, force: true });
}

/** @type {string[]} */
const failures = [];
const expect = (ok, message) => {
  if (!ok) failures.push(message);
};

expect(status === 0, `mocha exited with status ${status}`);
expect(reports.length === probes.length, `expected ${probes.length} probe reports, got ${reports.length}`);
expect(new Set(reports.map(r => r.pid)).size === reports.length,
  'the probes ran in one process: --parallel did not use two workers, so nothing was compared');

for (const key of ['tmpdir', 'mutexPath', 'gitGlobal', 'npmUser']) {
  const values = [...new Set(reports.map(r => r[key]))];
  expect(values.length === reports.length, `workers share ${key}: ${values.join(', ')}`);
}

for (const r of reports) {
  expect(r.mutexPath !== sharedMutex, `worker ${r.pid} uses the shared Git config mutex ${sharedMutex}`);
  if (path.resolve(r.tmpdir) === path.resolve(systemTmp)) {
    failures.push(`worker ${r.pid} uses the system temporary directory ${systemTmp}`);
    continue;
  }
  const workerDir = path.dirname(r.tmpdir);
  const runDir = path.dirname(workerDir);
  expect(isInside(r.tmpdir, r.mutexPath), `worker ${r.pid}: mutex ${r.mutexPath} is not in its tmpdir ${r.tmpdir}`);
  expect(r.gitGlobal === path.join(workerDir, 'gitconfig'),
    `worker ${r.pid}: GIT_CONFIG_GLOBAL ${r.gitGlobal} is not in its directory ${workerDir}`);
  expect(r.npmUser === path.join(workerDir, 'npmrc'),
    `worker ${r.pid}: NPM_CONFIG_USERCONFIG ${r.npmUser} is not in its directory ${workerDir}`);
  expect(path.dirname(runDir) === systemTmp && path.basename(runDir).startsWith('otak-proxy-unit-'),
    `worker ${r.pid}: directory ${workerDir} is not inside an otak-proxy-unit-* run directory`);
  expect(!fs.existsSync(workerDir), `worker ${r.pid}: ${workerDir} was left behind`);
}

const added = [...unitRunDirs()].filter(name => !before.has(name));
expect(added.length === 0, `left behind in ${systemTmp}: ${added.join(', ')}`);

if (failures.length > 0) {
  console.error(`Unit worker isolation check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`Unit worker isolation OK: ${reports.length} workers, each with its own tmpdir, Git config mutex, Git and npm config; nothing left behind.`);
