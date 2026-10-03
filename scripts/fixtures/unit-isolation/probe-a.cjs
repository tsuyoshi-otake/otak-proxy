'use strict';

const { record, holdWorker } = require('./record.cjs');

suite('unit worker isolation probe a', () => {
  test('records the isolation of this mocha process', async () => {
    await holdWorker();
    record('a');
  });
});
