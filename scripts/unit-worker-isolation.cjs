// Loaded by mocha (--require) in the main process and in every --parallel
// worker, before any test module. Each process gets its own temporary
// directory, Git global config, and npm user config under the root that
// scripts/lib/unit-mocha.mjs creates. The Git config mutex
// (os.tmpdir()/otak-proxy.gitconfig.mutex) and the config files are then
// never shared with another worker, another test run, or an installed copy
// of the extension (#103).
//
// The runner owns the root and removes it after mocha exits. A worker does
// not clean up after itself: --bail force-terminates the pool, and a killed
// worker runs no exit handler.
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.env.OTAK_PROXY_UNIT_ISOLATION_ROOT;
if (root) {
  const dir = fs.mkdtempSync(path.join(root, `w-${process.pid}-`));
  const tmp = path.join(dir, 'tmp');
  const gitconfig = path.join(dir, 'gitconfig');
  const npmrc = path.join(dir, 'npmrc');
  fs.mkdirSync(tmp);
  fs.writeFileSync(gitconfig, '');
  fs.writeFileSync(npmrc, '');

  // os.tmpdir() reads these on every call: TEMP, then TMP on Windows;
  // TMPDIR first elsewhere. Child processes (git, npm) inherit all of them.
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
  process.env.TMPDIR = tmp;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.NPM_CONFIG_USERCONFIG = npmrc;
  process.env.npm_config_userconfig = npmrc;
}
