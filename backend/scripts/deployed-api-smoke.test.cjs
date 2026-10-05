'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  resolveStage,
  totp,
  ownedCondition,
  minimalDeletionMarker,
  revocationKeys,
  jsonHeaders,
  activeEntityIds,
} = require('./deployed-api-smoke.cjs');

test('JSON content type is sent only when the request has a body', () => {
  assert.deepEqual(jsonHeaders(undefined), {});
  assert.deepEqual(jsonHeaders({}), { 'Content-Type': 'application/json' });
  assert.deepEqual(jsonHeaders(null), { 'Content-Type': 'application/json' });
});

test('pagination comparison ignores other entity types in a shared table', () => {
  assert.deepEqual(
    activeEntityIds(
      [
        { id: 'lot-2', entityType: 'INVENTORY_LOT' },
        { id: 'waste-1', entityType: 'WASTE_EVENT' },
        { id: 'lot-1', entityType: 'INVENTORY_LOT' },
        { id: 'lot-3', entityType: 'INVENTORY_LOT', archivedAt: 'now' },
      ],
      'INVENTORY_LOT',
    ),
    ['lot-1', 'lot-2'],
  );
});

test('only minimal bounded deletion markers may remain after account deletion', () => {
  const now = Date.now();
  const expiresAt = new Date(now + 86400_000);
  const marker = {
    pk: 'PANTRY_QUOTA#own',
    entityType: 'PANTRY_QUOTA',
    ownerUserId: 'own',
    deleting: true,
    expiresAt: expiresAt.toISOString(),
    expiresAtEpochSeconds: Math.floor(expiresAt.getTime() / 1000),
  };
  assert.equal(minimalDeletionMarker(marker, 'own', now), true);
  for (const bad of [
    { ...marker, activeProductTypes: 0 },
    { ...marker, response: {} },
    { ...marker, deleting: false },
    { ...marker, ownerUserId: 'other' },
    { ...marker, expiresAt: new Date(now - 1).toISOString() },
    { ...marker, expiresAt: new Date(now + 2 * 86400_000).toISOString() },
  ]) {
    assert.equal(minimalDeletionMarker(bad, 'own', now), false);
  }
  assert.equal(new Set(revocationKeys('own')).size, 1);
  assert.ok(
    revocationKeys('own').every((key) =>
      /^ACCOUNT_REVOCATION#[a-f0-9]{64}$/.test(key),
    ),
  );
});

test('only exact stage allowlist resolves production targets', () => {
  assert.equal(resolveStage('dev').host, 'dev.despensalista.lynxpardelle.com');
  assert.equal(resolveStage('tst').host, 'test.despensalista.lynxpardelle.com');
  assert.equal(resolveStage('prod').host, 'despensalista.lynxpardelle.com');
  for (const value of ['', undefined, 'production', 'DEV', '../prod']) {
    assert.throws(() => resolveStage(value));
  }
});

test('CLI cannot execute AWS without exact explicit --run arguments', () => {
  const script = path.join(__dirname, 'deployed-api-smoke.cjs');
  for (const args of [
    [],
    ['--help'],
    ['--stage', 'dev'],
    ['--run'],
    ['--stage', 'prod', '--run', '--force'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.match(result.stdout + result.stderr, /Usage:|Only --stage/);
    assert.doesNotMatch(result.stdout + result.stderr, /preflight/);
  }
});

test('TOTP follows RFC 6238 SHA-1 vectors and accepts Cognito base32', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const [seconds, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [20000000000, '65353130'],
  ]) {
    assert.equal(totp(secret, seconds * 1000, 8), expected);
  }
  assert.equal(totp(secret.toLowerCase(), 59_000), '287082');
  assert.throws(() => totp('not a valid secret!'));
});

test('cleanup condition rejects unrelated or ambiguous ownership', () => {
  const fixture = { sub: 'own-sub', households: new Set(['own-household']) };
  assert.equal(
    ownedCondition(
      { pk: 'USER#own-sub', entityType: 'USER', id: 'own-sub' },
      fixture,
    ).field,
    'id',
  );
  assert.equal(
    ownedCondition({ pk: 'EMAIL#qa', userId: 'own-sub' }, fixture).field,
    'userId',
  );
  assert.equal(
    ownedCondition({ pk: 'receipt', ownerUserId: 'own-sub' }, fixture).field,
    'ownerUserId',
  );
  assert.equal(
    ownedCondition({ pk: 'activity', householdId: 'own-household' }, fixture)
      .field,
    'householdId',
  );
  assert.equal(
    ownedCondition({ pk: 'unrelated', userId: 'someone-else' }, fixture),
    null,
  );
  assert.equal(
    ownedCondition(
      { pk: 'USER#someone-else', entityType: 'USER', id: 'someone-else' },
      fixture,
    ),
    null,
  );
  assert.equal(
    ownedCondition({ pk: 'undefined' }, { households: new Set() }),
    null,
  );
  assert.equal(ownedCondition({ pk: 'looks-like-own-sub' }, fixture), null);
});
