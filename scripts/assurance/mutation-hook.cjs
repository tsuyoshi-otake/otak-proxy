const fs = require('fs');
const path = require('path');
const Module = require('module');

const outputRoot = process.env.OTAK_PROXY_MUTATION_DIR;
const repository = process.env.OTAK_PROXY_MUTATION_REPO;
if (!outputRoot || !repository) {
  throw new Error('OTAK_PROXY_MUTATION_DIR and OTAK_PROXY_MUTATION_REPO are required for the mutation hook');
}

const originalJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function assuranceMutationLoader(module, filename) {
  const relativeToOut = path.relative(path.join(repository, 'out'), filename);
  const replacement = path.join(outputRoot, 'out', relativeToOut);
  if (!relativeToOut.startsWith('..') && fs.existsSync(replacement)) {
    const marker = process.env.OTAK_PROXY_MUTATION_LOADED;
    if (marker) {
      fs.writeFileSync(marker, JSON.stringify({ filename, replacement, loadedAt: new Date().toISOString() }));
    }
    module._compile(fs.readFileSync(replacement, 'utf8'), filename);
    return;
  }
  originalJsLoader(module, filename);
};
