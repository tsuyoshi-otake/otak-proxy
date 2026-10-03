import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runUnitMocha } from './lib/unit-mocha.mjs';

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

const parallel = !!process.env.OTAK_PROXY_UNIT_PARALLEL;
const jobs = Math.max(2, Math.min(8, (os.cpus()?.length ?? 4)));
// Some suites do real external command round-trips (git/npm). Keep timeouts generous to avoid flakes.
const timeoutMs = process.env.OTAK_PROXY_TEST_FAST ? 60000 : 120000;

// Some test suites do real round-trips against shared keys (git http.proxy, npm proxy).
// Running them under mocha --parallel is inherently racy, so run those serially while
// keeping the rest parallel for speed.
const serialBasenames = new Set([
  'GitConfigManager.test.js',
  'GitConfigManager.multivalue.test.js',
  'GitConfigManager.partialwrite.test.js',
  'GitConfigManager.valueunset.test.js',
  'NpmConfigManager.test.js',
  'NpmConfigManager.partialwrite.test.js',
  'NpmConfigManager.property.test.js',
]);
const serialTests = unitTests.filter(p => serialBasenames.has(path.basename(p)));
const parallelSafeTests = unitTests.filter(p => !serialBasenames.has(path.basename(p)));

let status = 0;
if (parallelSafeTests.length > 0) {
  status = runUnitMocha(repoRoot, parallelSafeTests, { parallel, jobs, timeoutMs });
}

if (status === 0 && serialTests.length > 0) {
  status = runUnitMocha(repoRoot, serialTests, { parallel: false, jobs, timeoutMs });
}

process.exit(status);
