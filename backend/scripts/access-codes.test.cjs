'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, createBatch, validateBatch } = require('./access-codes.cjs');
const { parseFixtureStage } = require('./deployed-access-code-smoke.cjs');

test('production smoke requires the explicit fixture flag before any AWS request', () => {
  assert.equal(parseFixtureStage(['--stage', 'dev', '--run']), 'dev');
  assert.equal(parseFixtureStage(['--stage', 'tst', '--run']), 'tst');
  assert.equal(parseFixtureStage(['--stage', 'prod', '--run-production-fixtures']), 'prod');
  assert.equal(parseFixtureStage(['--stage', 'prod', '--run']), undefined);
  assert.equal(parseFixtureStage(['--stage', 'prod']), undefined);
  assert.equal(parseFixtureStage(['--stage', 'production', '--run-production-fixtures']), undefined);
  assert.equal(parseFixtureStage(['--stage', 'prod', '--run-production-fixtures', '--extra']), undefined);
});

test('operator defaults to dry-run and validates plan and stage', () => {
  const args = ['issue', '--stage', 'dev', '--plan', 'plus', '--months', '2', '--reason', 'beta'];
  assert.equal(parseArgs(args).apply, false);
  assert.equal(parseArgs(args).months, 2);
  assert.throws(() => parseArgs(args.map((arg) => arg === 'dev' ? 'production' : arg)));
  assert.throws(() => parseArgs([...args, '--apply']));
  assert.throws(() => parseArgs([...args, '--stage', 'prod']));
});

test('lifetime developer grant requires bound email and no duration', () => {
  const args = ['issue', '--stage', 'dev', '--plan', 'pro', '--mode', 'developer', '--lifetime', '--reason', 'creator'];
  assert.throws(() => parseArgs(args));
  const options = parseArgs([...args, '--email', 'CREATOR@example.test']);
  assert.equal(options.recipientEmail, 'creator@example.test');
  assert.equal(options.lifetime, true);
  assert.throws(() => parseArgs([...args, '--email', 'creator@example.test', '--months', '1']));
});

test('generated batches have separate unpredictable one-use bearer codes and no stored digest copy', () => {
  const options = parseArgs(['issue', '--stage', 'tst', '--plan', 'plus', '--months', '3', '--count', '3', '--reason', 'beta']);
  const batch = createBatch(options, 'test-operator');
  validateBatch(batch, 'tst');
  assert.equal(new Set(batch.records.map(({ code }) => code)).size, 3);
  for (const row of batch.records) {
    assert.match(row.code, /^DL1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(row.code.split('.')[2], 'base64url').length, 32);
    assert.equal(row.metadata.secretHash, undefined);
    assert.equal(row.publication, 'pending');
  }
  assert.throws(() => validateBatch(batch, 'prod'));
  batch.records[0].code = batch.records[1].code;
  assert.throws(() => validateBatch(batch, 'tst'));
});

test('revocation requires issuance id and a reason, with dry-run default', () => {
  const id = '3c477b6e-9c10-4e77-8886-0ef31055f677';
  assert.equal(parseArgs(['revoke', '--stage', 'prod', '--id', id, '--reason', 'issued-in-error']).apply, false);
  assert.throws(() => parseArgs(['revoke', '--stage', 'prod', '--id', 'not-id', '--reason', 'x']));
});
