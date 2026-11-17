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

async function run() {
  const srp = loadSrp();
  const sdk = require('@aws-sdk/client-cognito-identity-provider');
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

  const selected = resolveStage('dev');
  assert.equal(awsJson('sts', 'get-caller-identity').Account, ACCOUNT);
  const auth = stackOutputs(`${selected.prefix}-cognito`);
  const backend = stackOutputs(`${selected.prefix}-serverless-backend`);
  assert.equal(backend.AppDomainName, selected.host);
  assert.equal(backend.DynamoDbUsersTable, 'despensalista-dev-users');
  assert.equal(
    backend.ServerlessBackendFunctionName,
    'despensalista-dev-backend-api',
  );
  assert.equal(backend.ServerlessBackendAliasName, 'live');
  const target = {
    base: `https://${selected.host}`,
    poolId: auth.UserPoolId,
    clientId: liveCognitoClientId(selected, auth, backend),
  };
  assert.match(target.poolId, /^us-east-1_[A-Za-z0-9]+$/);
  const settings = awsJson(
    'lambda',
    'get-function-configuration',
    '--function-name',
    backend.ServerlessBackendFunctionName,
    '--qualifier',
    'live',
    '--query',
    'Environment.Variables.{enabled:HOUSEHOLD_SWITCH_ENABLED,pool:COGNITO_USER_POOL_ID,client:COGNITO_CLIENT_ID,table:DYNAMODB_USERS_TABLE}',
  );
  assert.deepEqual(settings, {
    enabled: 'true',
    pool: target.poolId,
    client: target.clientId,
    table: backend.DynamoDbUsersTable,
  });
  const table = awsJson(
    'dynamodb',
    'describe-table',
    '--table-name',
    settings.table,
  ).Table;
  assert.equal(
    table.TableArn,
    `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${settings.table}`,
  );
  assert.equal(table.TableStatus, 'ACTIVE');

  const config = new ConfigService({
    DYNAMODB_REGION: REGION,
    DYNAMODB_USERS_TABLE: settings.table,
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
  const cognito = new sdk.CognitoIdentityProviderClient({ region: REGION });
  const fixtures = [];
  let phase = 'preflight';
  let failed = false;

  const event = (status, extra = {}) =>
    console.log(JSON.stringify({ stage: 'dev', phase, status, ...extra }));
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

  async function fixture(label) {
    const email = `qa-household-${label}-${randomUUID()}@example.invalid`;
    const account = {
      label,
      email,
      username: email,
      password: `Qa!7${randomBytes(32).toString('base64url')}`,
      xsrf: randomBytes(24).toString('hex'),
    };
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
          { Name: 'name', Value: email.split('@')[0] },
        ],
      }),
    );
    account.username = created.User.Username;
    account.sub = created.User.Attributes.find(
      ({ Name }) => Name === 'sub',
    )?.Value;
    assert.match(account.sub, /^[0-9a-f-]{36}$/);
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

  const home = (account) => api(account, 'GET', 'household', 200);
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
    const switched = await accept(account, token, 201, before.household.id);
    assert.equal(switched.household.id, after.household.id);
    assert.equal(switched.currentMember.role, 'editor');
    const retry = await accept(account, token, 201, before.household.id);
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
    const mfa = await cognito.send(
      new sdk.GetUserPoolMfaConfigCommand({ UserPoolId: target.poolId }),
    );
    assert.equal(mfa.MfaConfiguration, 'ON');
    assert.equal(mfa.SoftwareTokenMfaConfiguration.Enabled, true);
    const client = await cognito.send(
      new sdk.DescribeUserPoolClientCommand({
        UserPoolId: target.poolId,
        ClientId: target.clientId,
      }),
    );
    assert.ok(
      client.UserPoolClient.ExplicitAuthFlows.includes('ALLOW_USER_SRP_AUTH'),
    );
    assert.equal(client.UserPoolClient.ClientSecret, undefined);
    await api(null, 'GET', 'healthz', 200);
    event('PASS');

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
        if (account.sub && (await dao.findByAuthSubject(account.sub))) {
          await api(account, 'DELETE', 'profile/account', 200, {
            confirmationText: 'ELIMINAR CUENTA',
          });
        } else {
          await cognito
            .send(
              new sdk.AdminDeleteUserCommand({
                UserPoolId: target.poolId,
                Username: account.username,
              }),
            )
            .catch((error) => {
              if (error.name !== 'UserNotFoundException') throw error;
            });
        }
        await delay(300);
        await assert.rejects(
          cognito.send(
            new sdk.AdminGetUserCommand({
              UserPoolId: target.poolId,
              Username: account.username,
            }),
          ),
          { name: 'UserNotFoundException' },
        );
        if (account.sub) {
          assert.equal(await dao.findByAuthSubject(account.sub), null);
          assert.deepEqual(
            await households.getHouseholdSwitchState(account.sub),
            {
              pristine: false,
              contextRequired: false,
            },
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
    cognito.destroy();
    db.client.destroy();
  }
  phase = 'summary';
  event(failed ? 'FAIL' : 'PASS');
  if (failed) process.exitCode = 1;
}

const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && args[0] === '--help')) {
  console.log(
    'Usage: node scripts/deployed-household-switch-smoke.cjs --stage dev --run\nRequires npm run build, AWS credentials and COGNITO_TEST_SRP_MODULE_PATH (see scripts/DEPLOYED_API_SMOKE.md).',
  );
} else if (
  args.length === 3 &&
  args[0] === '--stage' &&
  args[1] === 'dev' &&
  args[2] === '--run'
) {
  run().catch((error) => {
    console.error(
      JSON.stringify({
        stage: 'dev',
        phase: 'preflight',
        status: 'FAIL',
        error: error.name,
      }),
    );
    process.exitCode = 1;
  });
} else {
  console.error('Only --stage dev --run is accepted.');
  process.exitCode = 1;
}
