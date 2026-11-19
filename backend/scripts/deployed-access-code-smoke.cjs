'use strict';
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readTarget } = require('./deployed-household-switch-smoke.cjs');
const { REGION, loadSrp, signIn, jsonHeaders } = require('./deployed-api-smoke.cjs');

async function run(stage) {
  const target = readTarget(stage);
  assert.ok(target.householdSwitchEnabled);
  const sdk = require('@aws-sdk/client-cognito-identity-provider');
  const { ConfigService } = require('@nestjs/config');
  const { CognitoProfileSyncService } = require('../dist/src/application/services/cognito-profile-sync.service');
  const { HouseholdSwitchAccessService } = require('../dist/src/application/services/household-switch-access.service');
  const { CognitoTokenVerifierService } = require('../dist/src/infrastructure/auth/cognito/cognito-token-verifier.service');
  const { DynamoDbDocumentClientService } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-document-client.service');
  const { DynamoDbHouseholdRepository } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-household.repository');
  const { DynamoDbUserDao } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-user.dao');
  const { AccessCodeStore } = require('../dist/src/infrastructure/access/access-code.store');
  const config = new ConfigService({
    PERSISTENCE_PROVIDER: 'dynamodb', DYNAMODB_REGION: REGION, DYNAMODB_USERS_TABLE: target.tableName,
    COGNITO_ISSUER: `https://cognito-idp.${REGION}.amazonaws.com/${target.poolId}`,
    COGNITO_CLIENT_ID: target.clientId, HOUSEHOLD_SWITCH_ENABLED: 'true',
  });
  config.skipProcessEnv = true;
  const db = new DynamoDbDocumentClientService(config);
  const users = new DynamoDbUserDao(db, config);
  const households = new DynamoDbHouseholdRepository(db, config);
  const codes = new AccessCodeStore(config, db);
  const sync = new CognitoProfileSyncService(users, new HouseholdSwitchAccessService(config, households));
  const verifier = new CognitoTokenVerifierService(config);
  const cognito = new sdk.CognitoIdentityProviderClient({ region: REGION, ignoreConfiguredEndpointUrls: true });
  const srp = loadSrp();
  const fixtures = [];
  const issued = [];
  let phase = 'preflight';
  let failed = false;
  const event = status => console.log(JSON.stringify({ stage, phase, status, version: target.version }));
  async function api(account, method, route, expected, body) {
    const response = await fetch(`${target.base}/api/${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(35000),
      headers: {
        ...jsonHeaders(body),
        ...(account ? {
          Cookie: `despensalista_access_token=${account.access}; XSRF-TOKEN=${account.xsrf}`,
          'x-xsrf-token': account.xsrf,
          ...(account.householdId ? { 'x-despensa-household': account.householdId } : {}),
        } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const content = await response.text();
    if (response.status !== expected) {
      const error = new Error(`${method} ${route} HTTP ${response.status}; expected ${expected}`);
      error.name = 'SmokeHttpError';
      throw error;
    }
    return content ? JSON.parse(content) : null;
  }
  async function fixture(label) {
    const email = `qa-access-${label}-${randomUUID()}@example.invalid`;
    const account = { label, email, name: email.split('@')[0], username: email,
      password: `Qa!7${randomBytes(32).toString('base64url')}`, xsrf: randomBytes(24).toString('hex') };
    assert.equal(await users.findByEmail(email), null);
    fixtures.push(account);
    const created = await cognito.send(new sdk.AdminCreateUserCommand({
      UserPoolId: target.poolId, Username: email, MessageAction: 'SUPPRESS', TemporaryPassword: account.password,
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: account.name }],
    }));
    account.username = created.User.Username;
    const attributes = Object.fromEntries(created.User.Attributes.map(({ Name, Value }) => [Name, Value]));
    assert.equal(attributes.email, email);
    assert.equal(attributes.name, account.name);
    account.sub = attributes.sub;
    await cognito.send(new sdk.AdminSetUserPasswordCommand({
      UserPoolId: target.poolId, Username: account.username, Password: account.password, Permanent: true,
    }));
    await signIn(srp, target, account, true);
    const tokens = await signIn(srp, target, account, false);
    const claims = await verifier.verifyIdToken(tokens.id);
    assert.equal(claims.sub, account.sub);
    assert.equal(claims.email, email);
    account.access = tokens.access;
    await sync.syncFromClaims(claims);
    const workspace = await api(account, 'GET', 'household', 200);
    account.householdId = workspace.household.id;
    assert.equal(workspace.household.ownerUserId, account.sub);
    assert.equal(workspace.plan.tier, 'free');
    return account;
  }
  async function issue(overrides = {}) {
    const id = randomUUID();
    const token = `DL1.${id}.${randomBytes(32).toString('base64url')}`;
    const now = new Date();
    const record = {
      id, plan: 'plus', mode: 'plan', months: 1, lifetime: false, createdAt: now.toISOString(),
      redeemUntil: new Date(now.getTime() + 86400000).toISOString(), reason: 'QA access-code smoke',
      state: 'issued', secretHash: createHash('sha256').update(token).digest('hex'), ...overrides,
    };
    assert.equal(await codes.issue(record), true);
    issued.push(id);
    return { id, token };
  }
  const redeem = (account, code, expected = 200, householdId = account.householdId) =>
    api(account, 'POST', 'household/access/redeem', expected, { code: code.token, householdId });
  try {
    await api(null, 'GET', 'household/access', 401);
    event('PASS');
    phase = 'temporary-plus-and-single-use';
    const a = await fixture('a');
    const b = await fixture('b');
    const month = await issue();
    const results = await Promise.allSettled([redeem(a, month), redeem(a, month)]);
    assert.ok(results.every(result => result.status === 'fulfilled'));
    assert.ok(results.some(result => result.value.replayed === true));
    assert.equal((await codes.readGrants(a.householdId)).grants.length, 1);
    assert.equal((await api(a, 'GET', 'household', 200)).plan.tier, 'plus');
    assert.equal((await redeem(b, month, 400)).code, 'ACCESS_CODE_USED');
    event('PASS');
    phase = 'origin-expiry-revocation';
    const expired = await issue({ redeemUntil: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await redeem(a, expired, 400)).code, 'ACCESS_CODE_EXPIRED');
    const revoked = await issue();
    assert.equal(await codes.revoke(revoked.id, 'QA unused revocation'), true);
    assert.equal((await redeem(a, revoked, 400)).code, 'ACCESS_CODE_REVOKED');
    const scoped = await issue();
    assert.equal((await redeem(a, scoped, 409, b.householdId)).code, 'HOUSEHOLD_ORIGIN_MISMATCH');
    assert.equal((await codes.readCode(scoped.id)).state, 'issued');
    event('PASS');
    phase = 'pro-and-developer-lifetime';
    const pro = await issue({ plan: 'pro', lifetime: true, months: undefined });
    await redeem(b, pro);
    const proPlan = (await api(b, 'GET', 'household', 200)).plan;
    assert.equal(proPlan.tier, 'pro');
    assert.equal(proPlan.lifetime, true);
    const developer = await issue({ plan: 'pro', mode: 'developer', lifetime: true, months: undefined });
    await redeem(a, developer);
    const developerPlan = (await api(a, 'GET', 'household', 200)).plan;
    assert.equal(developerPlan.unlimitedUsage, true);
    assert.equal(developerPlan.memberLimit, null);
    assert.equal(developerPlan.savedListLimit, null);
    assert.equal((await api(a, 'GET', 'household/access', 200)).canRedeem, true);
    event('PASS');
    phase = 'revoke-benefits-with-data-retained';
    const list = await api(a, 'POST', 'pantry/shopping-lists', 201, {
      title: 'QA gift retention',
      items: [{ productTypeId: randomUUID(), baseName: 'Arroz de prueba', quantity: 1, unit: 'piezas' }],
    });
    assert.equal(await codes.revoke(developer.id, 'QA used revocation'), true);
    assert.equal(await codes.revoke(month.id, 'QA temporal revocation'), true);
    assert.equal((await api(a, 'GET', 'household', 200)).plan.tier, 'free');
    const lists = await api(a, 'GET', 'pantry/shopping-lists', 200);
    assert.ok(lists.some(saved => saved.id === list.id));
    assert.equal((await redeem(a, month, 400)).code, 'ACCESS_CODE_REVOKED');
    event('PASS');
  } catch (error) {
    failed = true;
    console.error(JSON.stringify({ stage, phase, status: 'FAIL', error: error.name,
      ...(error.name === 'SmokeHttpError' ? { detail: error.message } : {}) }));
  } finally {
    phase = 'cleanup';
    for (const account of fixtures.reverse()) {
      try {
        if (account.sub && await users.findByAuthSubject(account.sub)) {
          await api(account, 'DELETE', 'profile/account', 200, { confirmationText: 'ELIMINAR CUENTA' });
        } else {
          const existing = await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: target.poolId, Username: account.username }))
            .catch(error => { if (error.name === 'UserNotFoundException') return null; throw error; });
          if (existing) {
            const attrs = Object.fromEntries(existing.UserAttributes.map(({ Name, Value }) => [Name, Value]));
            assert.equal(attrs.email, account.email); assert.equal(attrs.name, account.name);
            await cognito.send(new sdk.AdminDeleteUserCommand({ UserPoolId: target.poolId, Username: account.username }));
          }
        }
        await assert.rejects(cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: target.poolId, Username: account.username })), { name: 'UserNotFoundException' });
        if (account.sub) assert.equal(await users.findByAuthSubject(account.sub), null);
        if (account.householdId) assert.equal((await codes.readGrants(account.householdId)).revision, 0);
      } catch (error) {
        failed = true;
        console.error(JSON.stringify({ stage, phase, status: 'FAIL', fixture: account.username, error: error.name }));
      }
    }
    for (const id of issued) {
      try {
        assert.equal(await codes.revoke(id, 'QA cleanup'), true);
        const record = await codes.readCode(id);
        assert.equal(record.state, 'revoked');
        assert.equal(record.redeemedHouseholdId, undefined);
      } catch (error) { failed = true; console.error(JSON.stringify({ stage, phase, status: 'FAIL', id, error: error.name })); }
    }
    event(failed ? 'FAIL' : 'PASS');
    cognito.destroy(); db.client.destroy();
  }
  phase = 'summary'; event(failed ? 'FAIL' : 'PASS');
  if (failed) process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args.length === 3 && args[0] === '--stage' && ['dev', 'tst'].includes(args[1]) && args[2] === '--run') {
  run(args[1]).catch(error => { console.error(JSON.stringify({ phase: 'preflight', status: 'FAIL', error: error.name })); process.exitCode = 1; });
} else {
  console.log('Usage: node scripts/deployed-access-code-smoke.cjs --stage dev|tst --run');
  if (args.length && args[0] !== '--help') process.exitCode = 1;
}
