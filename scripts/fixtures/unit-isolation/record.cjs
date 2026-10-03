// Shared by the unit worker isolation probes (#103). Writes what the current
// mocha process sees: its temporary directory, the Git config mutex path that
// the compiled GitConfigLocking module computed at load, and the Git and npm
// config files that git and npm children would use.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function record(probe) {
  const outDir = process.env.OTAK_PROXY_ISOLATION_PROBE_OUT;
  if (!outDir) {
    throw new Error('OTAK_PROXY_ISOLATION_PROBE_OUT is not set; run scripts/check-unit-worker-isolation.mjs');
  }
  const { GIT_CONFIG_MUTEX_PATH } = require(path.join(repoRoot, 'out', 'config', 'GitConfigLocking.js'));
  const report = {
    probe,
    pid: process.pid,
    tmpdir: os.tmpdir(),
    mutexPath: GIT_CONFIG_MUTEX_PATH,
    gitGlobal: process.env.GIT_CONFIG_GLOBAL ?? null,
    npmUser: process.env.NPM_CONFIG_USERCONFIG ?? null,
  };
  fs.writeFileSync(path.join(outDir, `${process.pid}-${probe}.json`), JSON.stringify(report));
}

// Long enough that mocha hands the second probe file to a second worker
// while the first one is still busy.
function holdWorker() {
  return new Promise(resolve => setTimeout(resolve, 300));
}

module.exports = { record, holdWorker };
