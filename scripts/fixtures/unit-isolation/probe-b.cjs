'use strict';

const { record, holdWorker } = require('./record.cjs');

suite('unit worker isolation probe b', () => {
  test('records the isolation of this mocha process', async () => {
    await holdWorker();
    record('b');
  });
});
