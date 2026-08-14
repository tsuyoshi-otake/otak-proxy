const fs = require('fs');
const path = require('path');

const observations = new Map();

globalThis.__otakProxyC2Observe = function observeAtomicCondition(id, value) {
  const entry = observations.get(id) || { trueCount: 0, falseCount: 0 };
  if (Boolean(value)) entry.trueCount += 1;
  else entry.falseCount += 1;
  observations.set(id, entry);
  return value;
};

function flush() {
  const output = process.env.OTAK_PROXY_C2_OBSERVATIONS;
  if (!output) return;
  const serialized = Object.fromEntries(observations.entries());
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, observations: serialized }, null, 2)}\n`, 'utf8');
}

process.once('exit', flush);
