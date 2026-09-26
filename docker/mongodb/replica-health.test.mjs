import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./replica-health.js', import.meta.url), 'utf8');
test('replica health initializes once, waits for primary, and never masks auth/replica errors', () => {
  for (const state of ['uninitialized', 'primary', 'secondary', 'error']) {
    let initiated = 0;
    let exitCode;
    const run = () => vm.runInNewContext(source, {
      process: { env: {} },
      db: { getSiblingDB: () => ({ auth: () => true }), hello: () => ({ isWritablePrimary: state === 'primary' }) },
      rs: {
        status: () => { if (state === 'uninitialized' || state === 'error') throw { code: state === 'uninitialized' ? 94 : 13 }; },
        initiate: config => { assert.equal(config._id, 'rs0'); assert.equal(config.members[0].host, 'mongodb:27017'); initiated += 1; },
      },
      quit: code => { exitCode = code; },
    });
    if (state === 'error') assert.throws(run);
    else { run(); assert.equal(exitCode, state === 'primary' ? 0 : 2); }
    assert.equal(initiated, state === 'uninitialized' ? 1 : 0);
  }
});
