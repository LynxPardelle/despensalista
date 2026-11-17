'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const {
  ACCOUNT,
  REGION,
  awsJson,
  jsonHeaders,
  liveCognitoClientId,
  loadSrp,
  resolveStage,
  signIn,
  stackOutputs,
} = require('./deployed-api-smoke.cjs');

const USAGE = [
  'Usage: node scripts/deployed-household-switch-smoke.cjs --stage dev|tst|prod',
  'Add --run in dev or tst to create temporary fixtures.',
  'Add --run-production-fixtures in prod to create temporary production fixtures.',
  'Fixture runs require npm run build and COGNITO_TEST_SRP_MODULE_PATH (see scripts/DEPLOYED_API_SMOKE.md).',
].join('\n');

function parseCommand(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    return { mode: 'help' };
  }
  assert.equal(args[0], '--stage');
  const { stage } = resolveStage(args[1]);
  if (args.length === 2) return { stage, mode: 'check' };
  const fixtureFlag = stage === 'prod' ? '--run-production-fixtures' : '--run';
  assert.ok(args.length === 3 && args[2] === fixtureFlag);
  return { stage, mode: 'fixtures' };
}

function readTarget(stage, readAws = awsJson, readStack = stackOutputs) {
  const selected = resolveStage(stage);
  assert.equal(readAws('sts', 'get-caller-identity').Account, ACCOUNT);
  const auth = readStack(`${selected.prefix}-cognito`);
  const backend = readStack(`${selected.prefix}-serverless-backend`);
  const tableName = `${selected.prefix}-users`;
  const functionName = `${selected.prefix}-backend-api`;
  assert.equal(backend.AppDomainName, selected.host);
  assert.equal(backend.DynamoDbUsersTable, tableName);
  assert.equal(backend.ServerlessBackendFunctionName, functionName);
  assert.equal(backend.ServerlessBackendAliasName, 'live');

  const { arn, version, settings } = readAws(
    'lambda',
    'get-function-configuration',
    '--function-name',
    functionName,
    '--qualifier',
    'live',
    '--query',
    '{arn:FunctionArn,version:Version,settings:Environment.Variables.{enabled:HOUSEHOLD_SWITCH_ENABLED,pool:COGNITO_USER_POOL_ID,client:COGNITO_CLIENT_ID,table:DYNAMODB_USERS_TABLE,checkout:STRIPE_BILLING_CHECKOUT_ENABLED,publicCheckout:STRIPE_BILLING_PUBLIC_CHECKOUT}}',
  );
  assert.equal(
    arn,
    `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${functionName}:live`,
    'Expected live Lambda alias',
  );
  assert.match(version, /^[1-9]\d*$/);
  const poolId = auth.UserPoolId;
  const clientId = liveCognitoClientId(
    selected,
    auth,
    backend,
    () => settings.client,
  );
  assert.match(poolId, /^us-east-1_[A-Za-z0-9]+$/);
  assert.match(clientId, /^[a-z0-9]+$/);
  assert.equal(settings.pool, poolId);
  assert.equal(settings.client, clientId);
  assert.equal(settings.table, tableName);
  const table = readAws(
    'dynamodb',
    'describe-table',
    '--table-name',
    tableName,
  ).Table;
  assert.equal(
    table.TableArn,
    `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${tableName}`,
  );
  assert.equal(table.TableStatus, 'ACTIVE');

  let host = selected.host;
  if (stage === 'prod') {
    assert.ok(
      settings.checkout === 'false' && settings.publicCheckout === 'false',
      'Expected production Stripe Checkout closed',
    );
    const distributionId = backend.CloudFrontDistributionId;
    assert.match(distributionId, /^E[A-Z0-9]+$/);
    const distribution = readAws(
      'cloudfront',
      'get-distribution',
      '--id',
      distributionId,
      '--query',
      'Distribution.{arn:ARN,status:Status,enabled:DistributionConfig.Enabled,aliases:DistributionConfig.Aliases.Items}',
    );
    assert.equal(
      distribution.arn,
      `arn:aws:cloudfront::${ACCOUNT}:distribution/${distributionId}`,
    );
    assert.equal(distribution.status, 'Deployed');
    assert.equal(distribution.enabled, true);
    host = 'despensalista.com';
    assert.ok(
      distribution.aliases?.includes(selected.host) &&
        distribution.aliases?.includes(host),
      'Expected canonical domain on the production CloudFront distribution',
    );
  }

  const pool = readAws(
    'cognito-idp',
    'describe-user-pool',
    '--user-pool-id',
    poolId,
    '--query',
    'UserPool.{id:Id,arn:Arn}',
  );
  assert.equal(pool.id, poolId);
  assert.equal(
    pool.arn,
    `arn:aws:cognito-idp:${REGION}:${ACCOUNT}:userpool/${poolId}`,
  );
  const mfa = readAws(
    'cognito-idp',
    'get-user-pool-mfa-config',
    '--user-pool-id',
    poolId,
    '--query',
    '{mode:MfaConfiguration,totp:SoftwareTokenMfaConfiguration.Enabled}',
  );
  assert.deepEqual(mfa, { mode: 'ON', totp: true });
  const client = readAws(
    'cognito-idp',
    'describe-user-pool-client',
    '--user-pool-id',
    poolId,
    '--client-id',
    clientId,
    '--query',
    'UserPoolClient.{pool:UserPoolId,client:ClientId,flows:ExplicitAuthFlows,hasSecret:ClientSecret!=`null`}',
  );
  assert.equal(client.pool, poolId);
  assert.equal(client.client, clientId);
  assert.equal(client.hasSecret, false);
  assert.ok(client.flows.includes('ALLOW_USER_SRP_AUTH'));

  return {
    base: `https://${host}`,
    poolId,
    clientId,
    tableName,
    version,
    householdSwitchEnabled: settings.enabled === 'true',
  };
}

async function checkPreflight({ stage, mode }) {
  assert.ok(
    !Object.keys(process.env).some((key) =>
      key.toUpperCase().startsWith('AWS_ENDPOINT_URL'),
    ),
    'Custom AWS endpoints are not allowed',
  );
  process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'true';
  const target = readTarget(stage);
  const response = await fetch(`${target.base}/api/healthz`, {
    redirect: 'error',
    signal: AbortSignal.timeout(35_000),
  });
  await response.body?.cancel();
  assert.equal(response.status, 200);
  if (mode === 'fixtures') {
    assert.ok(
      target.householdSwitchEnabled,
      'Household switching must be enabled on the live alias',
    );
  }
  console.log(
    JSON.stringify({
      stage,
      mode,
      phase: 'preflight',
      status: 'PASS',
      version: target.version,
      householdSwitchEnabled: target.householdSwitchEnabled,
    }),
  );
  return target;
}

async function run(stage, target) {
  const srp = loadSrp();
  const sdk = require('@aws-sdk/client-cognito-identity-provider');
  const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
  const { ConfigService } = require('@nestjs/config');
  const {
    CognitoProfileSyncService,
  } = require('../dist/src/application/services/cognito-profile-sync.service');
  const {
    HouseholdSwitchAccessService,
  } = require('../dist/src/application/services/household-switch-access.service');
  const {
    CognitoTokenVerifierService,
  } = require('../dist/src/infrastructure/auth/cognito/cognito-token-verifier.service');
  const {
    DynamoDbDocumentClientService,
  } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-document-client.service');
  const {
    DynamoDbHouseholdRepository,
  } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-household.repository');
  const {
    DynamoDbUserDao,
  } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-user.dao');
  const { UserId } = require('../dist/src/domain/value-objects/user-id.vo');

  const config = new ConfigService({
    DYNAMODB_REGION: REGION,
    DYNAMODB_USERS_TABLE: target.tableName,
    COGNITO_ISSUER: `https://cognito-idp.${REGION}.amazonaws.com/${target.poolId}`,
    COGNITO_CLIENT_ID: target.clientId,
    HOUSEHOLD_SWITCH_ENABLED: 'true',
  });
  config.skipProcessEnv = true;
  const db = new DynamoDbDocumentClientService(config);
  const dao = new DynamoDbUserDao(db, config);
  const households = new DynamoDbHouseholdRepository(db, config);
  const sync = new CognitoProfileSyncService(
    dao,
    new HouseholdSwitchAccessService(config, households),
  );
  const verifier = new CognitoTokenVerifierService(config);
  const cognito = new sdk.CognitoIdentityProviderClient({
    region: REGION,
    ignoreConfiguredEndpointUrls: true,
  });
  const fixtures = [];
  let phase = 'preflight';
  let failed = false;

  const event = (status, extra = {}) =>
    console.log(JSON.stringify({ stage, phase, status, ...extra }));
  async function api(
    fixture,
    method,
    route,
    expected,
    body,
    { key, origin } = {},
  ) {
    const response = await fetch(`${target.base}/api/${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(35_000),
      headers: {
        ...jsonHeaders(body),
        ...(fixture
          ? {
              Cookie: `despensalista_access_token=${fixture.access}; XSRF-TOKEN=${fixture.xsrf}`,
              'x-xsrf-token': fixture.xsrf,
            }
          : {}),
        ...(key ? { 'idempotency-key': key } : {}),
        ...(origin ? { 'x-despensa-household': origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const content = await response.text();
    if (response.status !== expected) {
      const error = new Error(
        `${method} ${route} returned HTTP ${response.status}; expected ${expected}`,
      );
      error.name = 'SmokeHttpError';
      error.status = response.status;
      throw error;
    }
    return content ? JSON.parse(content) : null;
  }

  async function findCognitoUser(username) {
    try {
      return await cognito.send(
        new sdk.AdminGetUserCommand({
          UserPoolId: target.poolId,
          Username: username,
        }),
      );
    } catch (error) {
      if (error.name === 'UserNotFoundException') return null;
      throw error;
    }
  }

  function fixtureSubject(attributes, account) {
    const values = Object.fromEntries(
      attributes.map(({ Name, Value }) => [Name, Value]),
    );
    assert.equal(values.email, account.email);
    assert.equal(values.name, account.name);
    assert.match(values.sub, /^[0-9a-f-]{36}$/);
    if (account.sub !== undefined) assert.equal(values.sub, account.sub);
    return values.sub;
  }

  async function fixture(label) {
    const email = `qa-household-${label}-${randomUUID()}@example.invalid`;
    const account = {
      label,
      email,
      name: email.split('@')[0],
      username: email,
      password: `Qa!7${randomBytes(32).toString('base64url')}`,
      xsrf: randomBytes(24).toString('hex'),
    };
    assert.equal(await findCognitoUser(email), null);
    assert.equal(await dao.findByEmail(email), null);
    fixtures.push(account);
    const created = await cognito.send(
      new sdk.AdminCreateUserCommand({
        UserPoolId: target.poolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: account.password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: account.name },
        ],
      }),
    );
    account.sub = fixtureSubject(created.User.Attributes, account);
    account.username = created.User.Username;
    await cognito.send(
      new sdk.AdminSetUserPasswordCommand({
        UserPoolId: target.poolId,
        Username: account.username,
        Password: account.password,
        Permanent: true,
      }),
    );
    await signIn(srp, target, account, true);
    const tokens = await signIn(srp, target, account, false);
    const [claims, access] = await Promise.all([
      verifier.verifyIdToken(tokens.id),
      verifier.verifyAccessToken(tokens.access),
    ]);
    assert.equal(claims.sub, account.sub);
    assert.equal(claims.email, email);
    assert.equal(access.sub, account.sub);
    account.access = tokens.access;
    assert.equal(await dao.findByEmail(email), null);
    assert.equal(await dao.findByAuthSubject(account.sub), null);
    const user = await sync.syncFromClaims(claims);
    assert.equal(user.id.toString(), account.sub);
    assert.deepEqual(await households.getHouseholdSwitchState(account.sub), {
      pristine: true,
      contextRequired: false,
    });
    return account;
  }

  async function home(account) {
    const workspace = await api(account, 'GET', 'household', 200);
    if (workspace.currentMember.role === 'owner') {
      assert.equal(workspace.household.ownerUserId, account.sub);
      account.ownedHouseholdId = workspace.household.id;
    }
    return workspace;
  }
  const invite = (from, to) =>
    api(from, 'POST', 'household/invites', 201, {
      email: to.email,
      role: 'editor',
    });
  async function accept(account, token, expected, switchFromHouseholdId) {
    const body = {
      token,
      ...(switchFromHouseholdId ? { switchFromHouseholdId } : {}),
    };
    // A newly issued token may not yet be visible in the secondary index.
    for (let attempt = 0; ; attempt++) {
      try {
        return await api(
          account,
          'POST',
          'household/invites/accept',
          expected,
          body,
        );
      } catch (error) {
        if (error.status !== 404 || attempt === 7) throw error;
        await delay(250);
      }
    }
  }
  async function switchHousehold(
    account,
    token,
    before,
    after,
    closesOriginal,
  ) {
    const preview = await accept(account, token, 400);
    assert.equal(preview.code, 'HOUSEHOLD_ALREADY_MEMBER');
    assert.deepEqual(preview.householdSwitch, {
      fromHouseholdId: before.household.id,
      fromName: before.household.name,
      toName: after.household.name,
      role: 'editor',
      closesOriginal,
    });
    assert.equal((await home(account)).household.id, before.household.id);
    const confirm = () => accept(account, token, 201, before.household.id);
    const attempts = await Promise.allSettled([confirm(), confirm()]);
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') throw attempt.reason;
    }
    const [switched, concurrent] = attempts.map((attempt) => attempt.value);
    assert.equal(switched.household.id, after.household.id);
    assert.equal(switched.currentMember.role, 'editor');
    assert.equal(concurrent.household.id, switched.household.id);
    assert.deepEqual(concurrent.currentMember, switched.currentMember);
    const retry = await confirm();
    assert.equal(retry.household.id, switched.household.id);
    assert.deepEqual(retry.currentMember, switched.currentMember);
  }

  try {
    const pool = await cognito.send(
      new sdk.DescribeUserPoolCommand({ UserPoolId: target.poolId }),
    );
    assert.equal(
      pool.UserPool.Arn,
      `arn:aws:cognito-idp:${REGION}:${ACCOUNT}:userpool/${target.poolId}`,
    );
    const { Table } = await db.send(
      new DescribeTableCommand({ TableName: target.tableName }),
    );
    assert.equal(
      Table.TableArn,
      `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${target.tableName}`,
    );
    phase = 'new-invitee-joins-before-household-provisioning';
    const a = await fixture('a');
    const b = await fixture('b');
    const c = await fixture('c');
    const [homeA, homeB] = await Promise.all([home(a), home(b)]);
    assert.equal(homeA.plan.tier, 'free');
    assert.equal(homeB.plan.tier, 'free');
    assert.equal(await households.findMembershipByUserId(c.sub), null);
    const toA = await invite(a, c);
    assert.equal(
      (await accept(c, toA.token, 201)).household.id,
      homeA.household.id,
    );
    const initialC = await home(c);
    assert.equal(initialC.currentMember.role, 'editor');
    event('PASS');

    phase = 'member-confirmation-and-retry';
    const toB = await invite(b, c);
    await switchHousehold(c, toB.token, initialC, homeB, false);
    assert.equal(
      await households.findMembershipByHouseholdAndUserId(
        homeA.household.id,
        c.sub,
      ),
      null,
    );
    event('PASS');

    phase = 'unused-owner-confirmation-and-retry';
    const d = await fixture('d');
    const homeD = await home(d);
    assert.equal(homeD.currentMember.role, 'owner');
    const nextToA = await invite(a, d);
    await switchHousehold(d, nextToA.token, homeD, homeA, true);
    assert.equal(await households.findHouseholdById(homeD.household.id), null);
    event('PASS');

    phase = 'stale-header-product-write';
    const draftType = {
      baseName: `QA arroz ${randomUUID().slice(0, 8)}`,
      category: 'food',
      defaultUnit: 'piezas',
    };
    const deniedWrite = await api(c, 'POST', 'product-types', 409, draftType, {
      origin: homeA.household.id,
    });
    assert.equal(deniedWrite.code, 'HOUSEHOLD_ORIGIN_MISMATCH');
    const type = await api(c, 'POST', 'product-types', 201, draftType, {
      origin: homeB.household.id,
    });
    event('PASS');

    phase = 'stale-purchase-origin';
    const items = [{ productTypeId: type.id, quantity: 3, unit: 'piezas' }];
    const key = randomUUID();
    for (const stale of [
      { originHouseholdId: homeA.household.id, items },
      { items },
    ]) {
      const denied = await api(c, 'POST', 'pantry/checkout', 409, stale, {
        key,
      });
      assert.equal(denied.code, 'HOUSEHOLD_ORIGIN_MISMATCH');
    }
    const checkout = { originHouseholdId: homeB.household.id, items };
    const options = { key, origin: homeB.household.id };
    const lots = await api(
      c,
      'POST',
      'pantry/checkout',
      201,
      checkout,
      options,
    );
    assert.equal(lots.length, 1);
    const retry = await api(
      c,
      'POST',
      'pantry/checkout',
      201,
      checkout,
      options,
    );
    assert.equal(retry[0]?.id, lots[0].id);
    let ownerLots;
    for (let attempt = 0; attempt < 8; attempt++) {
      ownerLots = await api(b, 'GET', 'inventory-lots', 200);
      if (ownerLots.some(({ id }) => id === lots[0].id)) break;
      await delay(250);
    }
    assert.equal(ownerLots.filter(({ id }) => id === lots[0].id).length, 1);
    assert.equal((await api(a, 'GET', 'inventory-lots', 200)).length, 0);
    event('PASS');
  } catch (error) {
    failed = true;
    event(
      'FAIL',
      error.name === 'SmokeHttpError'
        ? { detail: error.message }
        : { error: error.name },
    );
  } finally {
    phase = 'cleanup';
    for (const account of fixtures.reverse()) {
      try {
        const identity = await findCognitoUser(account.username);
        if (identity)
          account.sub = fixtureSubject(identity.UserAttributes, account);
        const profile = account.sub
          ? await dao.findByAuthSubject(account.sub)
          : null;
        if (profile) {
          assert.equal(profile.id.toString(), account.sub);
          assert.equal(profile.email, account.email);
          await api(account, 'DELETE', 'profile/account', 200, {
            confirmationText: 'ELIMINAR CUENTA',
          });
        } else if (identity) {
          await cognito
            .send(
              new sdk.AdminDeleteUserCommand({
                UserPoolId: target.poolId,
                Username: identity.Username,
              }),
            )
            .catch((error) => {
              if (error.name !== 'UserNotFoundException') throw error;
            });
        }
        await delay(300);
        assert.equal(await findCognitoUser(account.username), null);
        assert.equal(await dao.findByEmail(account.email), null);
        if (account.sub) {
          assert.equal(await dao.findByAuthSubject(account.sub), null);
          assert.equal(
            await dao.findById(UserId.fromString(account.sub)),
            null,
          );
          assert.equal(
            await households.findMembershipByUserId(account.sub),
            null,
          );
          assert.deepEqual(
            await households.getHouseholdSwitchState(account.sub),
            {
              pristine: false,
              contextRequired: false,
            },
          );
        }
        if (account.ownedHouseholdId) {
          assert.equal(
            await households.findHouseholdById(account.ownedHouseholdId),
            null,
          );
        }
      } catch (error) {
        failed = true;
        event('FAIL', {
          fixture: account.label,
          fixtureUsername: account.username,
          error: error.name,
        });
      }
    }
    if (fixtures.length && !failed) event('PASS');
    cognito.destroy();
    db.client.destroy();
  }
  phase = 'summary';
  event(failed ? 'FAIL' : 'PASS');
  if (failed) process.exitCode = 1;
}

async function main(args) {
  let command;
  try {
    command = parseCommand(args);
  } catch {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (command.mode === 'help') {
    console.log(USAGE);
    return;
  }
  try {
    const target = await checkPreflight(command);
    if (command.mode === 'fixtures') await run(command.stage, target);
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: command.stage,
        phase: 'preflight',
        status: 'FAIL',
        error: error.name,
      }),
    );
    process.exitCode = 1;
  }
}

if (require.main === module) void main(process.argv.slice(2));
module.exports = { parseCommand, readTarget };
