const fs = require('fs');
const path = require('path');
const Module = require('module');

require('./c2-runtime.cjs');

const outputRoot = process.env.OTAK_PROXY_C2_DIR;
const repository = process.env.OTAK_PROXY_C2_REPO;
if (!outputRoot || !repository) {
  throw new Error('OTAK_PROXY_C2_DIR and OTAK_PROXY_C2_REPO are required for the C2 hook');
}

const originalJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function assuranceC2Loader(module, filename) {
  const relativeToOut = path.relative(path.join(repository, 'out'), filename);
  const replacement = path.join(outputRoot, 'out', relativeToOut);
  if (!relativeToOut.startsWith('..') && fs.existsSync(replacement)) {
    module._compile(fs.readFileSync(replacement, 'utf8'), filename);
    return;
  }
  originalJsLoader(module, filename);
};
