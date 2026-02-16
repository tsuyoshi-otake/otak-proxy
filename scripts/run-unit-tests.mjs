import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function isVscodeDependentTestFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const base = path.basename(filePath);
  return (
    src.includes("require('vscode')") ||
    src.includes('require(\"vscode\")') ||
    src.includes("from 'vscode'") ||
    src.includes('from \"vscode\"') ||
    // Pulling in VscodeConfigManager (even indirectly) requires the extension host module.
    src.includes('VscodeConfigManager') ||
    src.includes('../config/VscodeConfigManager') ||
    src.includes('..\\\\config\\\\VscodeConfigManager') ||
    // Extension-level integration suites are intended for VS Code host.
    base.startsWith('extension.') ||
    // Integration tests are typically intended for the VS Code extension host.
    /[/\\\\]integration[/\\\\]/.test(filePath) ||
    filePath.includes('.integration.')
  );
}

const repoRoot = process.cwd();
const outTestDir = path.join(repoRoot, 'out', 'test');
if (!fs.existsSync(outTestDir)) {
  console.error('out/test not found. Run `npm run compile` first.');
  process.exit(2);
}

const allTests = walk(outTestDir).filter(p => p.endsWith('.test.js'));
const unitTests = allTests.filter(p => !isVscodeDependentTestFile(p));

if (unitTests.length === 0) {
  console.log('No unit tests detected (all tests appear VS Code-dependent).');
  process.exit(0);
}

// Use mocha's CLI to keep behavior predictable.
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
const nodeExe = process.execPath;

const shim = path.join(repoRoot, 'scripts', 'vscode-shim.cjs');
const parallel = !!process.env.OTAK_PROXY_UNIT_PARALLEL;
const jobs = Math.max(2, Math.min(8, (os.cpus()?.length ?? 4)));
// Some suites do real external command round-trips (git/npm). Keep timeouts generous to avoid flakes.
const timeoutMs = process.env.OTAK_PROXY_TEST_FAST ? 60000 : 120000;

function ensureFile(p) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort
  }
}

// Make unit tests hermetic: do not touch the user's actual Git global config or npm user config.
// This also reduces flakiness when running tests in parallel.
const hermeticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-unit-'));
const hermeticGitConfig = path.join(hermeticDir, 'gitconfig');
const hermeticNpmrc = path.join(hermeticDir, 'npmrc');
ensureFile(hermeticGitConfig);
ensureFile(hermeticNpmrc);

const hermeticEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: hermeticGitConfig,
  NPM_CONFIG_USERCONFIG: hermeticNpmrc,
  npm_config_userconfig: hermeticNpmrc,
};

// Some test suites do real round-trips against shared keys (git http.proxy, npm proxy).
// Running them under mocha --parallel is inherently racy, so run those serially while
// keeping the rest parallel for speed.
const serialBasenames = new Set([
  'GitConfigManager.test.js',
  'NpmConfigManager.test.js',
  'NpmConfigManager.property.test.js',
]);
const serialTests = unitTests.filter(p => serialBasenames.has(path.basename(p)));
const parallelSafeTests = unitTests.filter(p => !serialBasenames.has(path.basename(p)));

function runMocha(testFiles, { forceSerial } = {}) {
  /** @type {string[]} */
  const args = [mochaBin, '--ui', 'tdd', '--require', shim, '--bail', '--exit', '--timeout', String(timeoutMs)];
  if (!forceSerial && parallel) {
    // Run test files in separate workers for speed and isolation.
    args.push('--parallel', '--jobs', String(jobs));
  }
  args.push(...testFiles);
  return spawnSync(nodeExe, args, {
    stdio: 'inherit',
    env: hermeticEnv,
  });
}

let status = 0;
if (parallelSafeTests.length > 0) {
  const res = runMocha(parallelSafeTests);
  status = res.status ?? 1;
}

if (status === 0 && serialTests.length > 0) {
  const res = runMocha(serialTests, { forceSerial: true });
  status = res.status ?? 1;
}

process.exit(status);
