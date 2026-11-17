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
  liveCognitoClientId,
} = require('./deployed-api-smoke.cjs');
const {
  parseCommand: parseHouseholdCommand,
  readTarget: readHouseholdTarget,
} = require('./deployed-household-switch-smoke.cjs');

test('household smoke defaults to read-only and requires an exact production fixture switch', () => {
  assert.deepEqual(parseHouseholdCommand([]), { mode: 'help' });
  for (const stage of ['dev', 'tst', 'prod']) {
    assert.deepEqual(parseHouseholdCommand(['--stage', stage]), {
      stage,
      mode: 'check',
    });
  }
  for (const stage of ['dev', 'tst']) {
    assert.deepEqual(parseHouseholdCommand(['--stage', stage, '--run']), {
      stage,
      mode: 'fixtures',
    });
  }
  assert.deepEqual(
    parseHouseholdCommand(['--stage', 'prod', '--run-production-fixtures']),
    {
      stage: 'prod',
      mode: 'fixtures',
    },
  );
  for (const args of [
    ['--stage', 'production'],
    ['--stage', 'prod', '--run'],
    ['--stage', 'tst', '--run-production-fixtures'],
    ['--stage', 'prod', '--run-production-fixtures', '--force'],
  ])
    assert.throws(() => parseHouseholdCommand(args));
});

test('household production preflight requires the canonical domain, exact live alias and closed sales', () => {
  const account = '765932874577';
  const region = 'us-east-1';
  const functionName = 'despensalista-prod-backend-api';
  const table = 'despensalista-prod-users';
  const pool = 'us-east-1_QaStub';
  const client = 'qaclient';
  const distribution = 'ECTEST00000000';
  const readStack = (name) => {
    if (name === 'despensalista-prod-cognito')
      return { UserPoolId: pool, UserPoolClientId: client };
    assert.equal(name, 'despensalista-prod-serverless-backend');
    return {
      AppDomainName: 'despensalista.lynxpardelle.com',
      CloudFrontDistributionId: distribution,
      DynamoDbUsersTable: table,
      ServerlessBackendFunctionName: functionName,
      ServerlessBackendAliasName: 'live',
    };
  };
  const preflight = ({
    aliases = ['despensalista.lynxpardelle.com', 'despensalista.com'],
    checkout = 'false',
    qualifier = 'live',
  } = {}) => {
    const readAws = (...args) => {
      const [service, action, parameter, value] = args;
      switch (`${service} ${action}`) {
        case 'sts get-caller-identity':
          return { Account: account };
        case 'lambda get-function-configuration':
          assert.deepEqual(args.slice(2, 6), [
            '--function-name',
            functionName,
            '--qualifier',
            'live',
          ]);
          return {
            arn: `arn:aws:lambda:${region}:${account}:function:${functionName}:${qualifier}`,
            version: '17',
            settings: {
              enabled: 'true',
              pool,
              client,
              table,
              checkout,
              publicCheckout: 'false',
            },
          };
        case 'dynamodb describe-table':
          assert.equal(parameter, '--table-name');
          assert.equal(value, table);
          return {
            Table: {
              TableStatus: 'ACTIVE',
              TableArn: `arn:aws:dynamodb:${region}:${account}:table/${table}`,
            },
          };
        case 'cloudfront get-distribution':
          assert.equal(parameter, '--id');
          assert.equal(value, distribution);
          return {
            arn: `arn:aws:cloudfront::${account}:distribution/${distribution}`,
            status: 'Deployed',
            enabled: true,
            aliases,
          };
        case 'cognito-idp describe-user-pool':
          assert.equal(value, pool);
          return {
            arn: `arn:aws:cognito-idp:${region}:${account}:userpool/${pool}`,
            id: pool,
          };
        case 'cognito-idp get-user-pool-mfa-config':
          return { mode: 'ON', totp: true };
        case 'cognito-idp describe-user-pool-client':
          assert.equal(value, pool);
          assert.deepEqual(args.slice(4, 6), ['--client-id', client]);
          return {
            pool,
            client,
            flows: ['ALLOW_USER_SRP_AUTH'],
            hasSecret: false,
          };
        default:
          assert.fail(`Unexpected AWS operation ${service} ${action}`);
      }
    };
    return readHouseholdTarget('prod', readAws, readStack);
  };
  assert.equal(preflight().base, 'https://despensalista.com');
  assert.throws(
    () => preflight({ aliases: ['despensalista.lynxpardelle.com', 'incorrect.example'] }),
    /canonical domain/,
  );
  assert.throws(
    () => preflight({ aliases: 'despensalista.lynxpardelle.com,despensalista.com' }),
    /canonical domain/,
  );
  assert.throws(() => preflight({ checkout: 'true' }), /checkout closed/i);
  assert.throws(() => preflight({ qualifier: 'canary' }), /live Lambda alias/);
});

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

test('dev smoke uses the Cognito client of the live alias after a rollback', () => {
  const auth = { UserPoolClientId: 'native', GoogleMfaUserPoolClientId: 'mfa' };
  const backend = {
    ServerlessBackendFunctionName: 'despensalista-dev-backend-api',
    ServerlessBackendAliasName: 'live',
  };
  const dev = resolveStage('dev');
  for (const clientId of ['native', 'mfa']) {
    assert.equal(liveCognitoClientId(dev, auth, backend, (...args) => {
      assert.deepEqual(args, [
        'lambda', 'get-function-configuration', '--function-name',
        'despensalista-dev-backend-api', '--qualifier', 'live', '--query',
        'Environment.Variables.COGNITO_CLIENT_ID',
      ]);
      return clientId;
    }), clientId);
  }
  assert.throws(() => liveCognitoClientId(dev, auth, backend, () => 'unknown'), /Cognito client/);
  const unexpectedAws = () => assert.fail('Unexpected Lambda read');
  assert.equal(liveCognitoClientId(dev, { UserPoolClientId: 'native' }, backend, unexpectedAws), 'native');
  assert.equal(liveCognitoClientId(resolveStage('prod'), auth, {}, unexpectedAws), 'native');
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
