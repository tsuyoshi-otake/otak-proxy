import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Runs mocha on built unit test files the way the unit lane does.
 *
 * Every mocha process (the main one and each --parallel worker) gets its own
 * temporary directory, Git global config, and npm user config under a fresh
 * root, through scripts/unit-worker-isolation.cjs (#103). This function owns
 * that root and removes it once mocha has exited, whatever the outcome.
 *
 * @param {string} repoRoot
 * @param {string[]} testFiles
 * @param {{ parallel: boolean, jobs: number, timeoutMs: number }} options
 * @returns {number} mocha's exit status; 1 when mocha could not be started
 */
export function runUnitMocha(repoRoot, testFiles, { parallel, jobs, timeoutMs }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'otak-proxy-unit-'));
  try {
    // Hermetic even for the main process before the hook runs: never the
    // developer's ~/.gitconfig or ~/.npmrc.
    const gitconfig = path.join(root, 'gitconfig');
    const npmrc = path.join(root, 'npmrc');
    fs.writeFileSync(gitconfig, '');
    fs.writeFileSync(npmrc, '');

    const args = [
      path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js'),
      '--ui', 'tdd',
      // Isolation first, so that no module, the shim included, sees the shared paths.
      '--require', path.join(repoRoot, 'scripts', 'unit-worker-isolation.cjs'),
      '--require', path.join(repoRoot, 'scripts', 'vscode-shim.cjs'),
      '--bail', '--exit', '--timeout', String(timeoutMs)
    ];
    if (parallel) {
      // Run test files in separate workers for speed and isolation.
      args.push('--parallel', '--jobs', String(jobs));
    }
    args.push(...testFiles);

    const res = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        OTAK_PROXY_UNIT_ISOLATION_ROOT: root,
        GIT_CONFIG_GLOBAL: gitconfig,
        NPM_CONFIG_USERCONFIG: npmrc,
        npm_config_userconfig: npmrc,
        OTAK_PROXY_LOG_SILENT: process.env.OTAK_PROXY_LOG_SILENT ?? '1',
      },
    });
    if (res.error) {
      console.error(`Could not run mocha: ${res.error.message}`);
    }
    return res.status ?? 1;
  } finally {
    removeIsolationRoot(root);
  }
}

function removeIsolationRoot(root) {
  try {
    // A git or npm child that has not exited yet can hold a handle on Windows.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`Could not remove the unit test directory ${root}: ${error.message}`);
  }
}
