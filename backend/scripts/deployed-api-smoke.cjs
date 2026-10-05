'use strict';

const assert = require('node:assert/strict');
const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');

const ACCOUNT = '765932874577';
const REGION = 'us-east-1';
const HOSTS = Object.freeze({
  dev: 'dev.despensalista.lynxpardelle.com',
  tst: 'test.despensalista.lynxpardelle.com',
  prod: 'despensalista.lynxpardelle.com',
});

function resolveStage(stage) {
  assert.ok(
    Object.hasOwn(HOSTS, stage),
    'Stage must be exactly dev, tst or prod',
  );
  return { stage, host: HOSTS[stage], prefix: `despensalista-${stage}` };
}

function totp(secret, now = Date.now(), digits = 6) {
  assert.match(secret, /^[A-Z2-7]+=*$/i, 'Invalid base32 secret');
  const bits = [...secret.toUpperCase().replace(/=+$/, '')]
    .map((char) =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
        .indexOf(char)
        .toString(2)
        .padStart(5, '0'),
    )
    .join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, '0');
}

function ownedCondition(item, fixture) {
  if (!fixture.sub) return null;
  for (const field of ['userId', 'ownerUserId', 'actorUserId']) {
    if (item[field] === fixture.sub) return { field, value: fixture.sub };
  }
  if (
    item.entityType === 'USER' &&
    item.id === fixture.sub &&
    item.pk === `USER#${fixture.sub}`
  ) {
    return { field: 'id', value: fixture.sub };
  }
  if (item.householdId && fixture.households.has(item.householdId)) {
    return { field: 'householdId', value: item.householdId };
  }
  return null;
}

function minimalDeletionMarker(item, owner, now = Date.now()) {
  const expected = [
    'pk',
    'entityType',
    'ownerUserId',
    'deleting',
    'expiresAt',
    'expiresAtEpochSeconds',
  ].sort();
  const expiresAt = new Date(item.expiresAt).getTime();
  return (
    item.pk === `PANTRY_QUOTA#${owner}` &&
    item.entityType === 'PANTRY_QUOTA' &&
    item.ownerUserId === owner &&
    item.deleting === true &&
    JSON.stringify(Object.keys(item).sort()) === JSON.stringify(expected) &&
    expiresAt > now &&
    expiresAt <= now + 86400_000 + 60_000 &&
    item.expiresAtEpochSeconds === Math.floor(expiresAt / 1000)
  );
}

function revocationKeys(subject) {
  return [
    `ACCOUNT_REVOCATION#${createHash('sha256').update(subject).digest('hex')}`,
  ];
}

function jsonHeaders(body) {
  return body === undefined ? {} : { 'Content-Type': 'application/json' };
}

function activeEntityIds(items, entityType) {
  return items
    .filter((item) => item.entityType === entityType && !item.archivedAt)
    .map((item) => item.id)
    .sort();
}

// CLI output and SDK payloads stay in memory: never log credentials or response bodies.
function awsJson(...args) {
  return JSON.parse(
    execFileSync(
      'aws',
      [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    ),
  );
}

function stackOutputs(name) {
  const stacks = awsJson(
    'cloudformation',
    'describe-stacks',
    '--stack-name',
    name,
  ).Stacks;
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].StackId.split(':')[4], ACCOUNT);
  assert.match(stacks[0].StackStatus, /^(CREATE|UPDATE)_COMPLETE$/);
  return Object.fromEntries(
    stacks[0].Outputs.map((item) => [item.OutputKey, item.OutputValue]),
  );
}

async function signIn(srp, target, fixture, enroll) {
  // The supported Cognito library handles SRP. TOTP uses Node crypto, not custom SRP.
  const values = new Map();
  const storage = {
    setItem: (key, value) => values.set(key, value),
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  const pool = new srp.CognitoUserPool({
    UserPoolId: target.poolId,
    ClientId: target.clientId,
    Storage: storage,
  });
  const user = new srp.CognitoUser({
    Username: fixture.email,
    Pool: pool,
    Storage: storage,
  });
  let challenged = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SRP timeout')), 120_000);
    const fail = (error) => {
      clearTimeout(timer);
      values.clear();
      reject(error);
    };
    const withCode = (callback) => {
      const remaining = 30_000 - (Date.now() % 30_000);
      const alreadyUsed =
        fixture.lastTotpCounter === Math.floor(Date.now() / 30_000);
      delay(remaining < 2_000 || alreadyUsed ? remaining + 100 : 0)
        .then(() => {
          fixture.lastTotpCounter = Math.floor(Date.now() / 30_000);
          callback(totp(fixture.totpSecret));
        })
        .catch(fail);
    };
    const callbacks = {
      onSuccess(session) {
        clearTimeout(timer);
        values.clear();
        if (!challenged)
          return reject(new Error('MFA challenge was not required'));
        resolve({
          access: session.getAccessToken().getJwtToken(),
          id: session.getIdToken().getJwtToken(),
        });
      },
      onFailure: fail,
      mfaSetup() {
        if (!enroll) return fail(new Error('Unexpected MFA enrollment'));
        challenged = true;
        user.associateSoftwareToken(callbacks);
      },
      associateSecretCode(secret) {
        fixture.totpSecret = secret;
        withCode((code) =>
          user.verifySoftwareToken(code, 'Temporary deployment QA', callbacks),
        );
      },
      totpRequired() {
        if (enroll || !fixture.totpSecret)
          return fail(new Error('Unexpected TOTP challenge'));
        challenged = true;
        withCode((code) =>
          user.sendMFACode(code, callbacks, 'SOFTWARE_TOKEN_MFA'),
        );
      },
      mfaRequired: () => fail(new Error('Unexpected SMS MFA')),
      newPasswordRequired: () =>
        fail(new Error('Unexpected password challenge')),
      selectMFAType: () =>
        user.sendMFASelectionAnswer('SOFTWARE_TOKEN_MFA', callbacks),
    };
    user.authenticateUser(
      new srp.AuthenticationDetails({
        Username: fixture.email,
        Password: fixture.password,
      }),
      callbacks,
    );
  });
}

async function run(stage) {
  const selected = resolveStage(stage);
  assert.ok(
    !Object.keys(process.env).some((key) => key.startsWith('AWS_ENDPOINT_URL')),
    'Custom AWS endpoints are not allowed',
  );
  const srpPath = process.env.COGNITO_TEST_SRP_MODULE_PATH;
  assert.ok(
    srpPath && path.isAbsolute(srpPath),
    'Set absolute COGNITO_TEST_SRP_MODULE_PATH outside repository',
  );
  const repository = path.resolve(__dirname, '../..');
  const relative = path.relative(repository, srpPath);
  assert.ok(
    relative.startsWith('..' + path.sep) || path.isAbsolute(relative),
    'SRP test tool must be outside repository',
  );
  const srp = require(srpPath);
  const cognitoSdk = require('@aws-sdk/client-cognito-identity-provider');
  const {
    DescribeTableCommand,
    DynamoDBClient,
  } = require('@aws-sdk/client-dynamodb');
  const {
    ScanCommand,
    GetCommand,
    UpdateCommand,
    DeleteCommand,
  } = require('@aws-sdk/lib-dynamodb');
  const { ConfigService } = require('@nestjs/config');
  const {
    DynamoDbDocumentClientService,
  } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-document-client.service');
  const {
    DynamoDbUserDao,
  } = require('../dist/src/infrastructure/database/dynamodb/dynamodb-user.dao');
  const {
    CognitoProfileSyncService,
  } = require('../dist/src/application/services/cognito-profile-sync.service');
  const {
    CognitoTokenVerifierService,
  } = require('../dist/src/infrastructure/auth/cognito/cognito-token-verifier.service');
  const limits = require('../dist/src/application/constants/query-limits');
  assert.equal(awsJson('sts', 'get-caller-identity').Account, ACCOUNT);
  const auth = stackOutputs(`${selected.prefix}-cognito`);
  const backend = stackOutputs(`${selected.prefix}-serverless-backend`);
  assert.equal(backend.AppDomainName, selected.host);
  const target = {
    poolId: auth.UserPoolId,
    clientId: auth.UserPoolClientId,
    base: `https://${selected.host}`,
    direct: backend.ServerlessBackendApiEndpoint,
    tables: [
      { name: backend.DynamoDbUsersTable, key: 'pk', suffix: 'users' },
      { name: backend.DynamoDbProductsTable, key: 'id', suffix: 'products' },
      {
        name: backend.DynamoDbProductTypesTable,
        key: 'id',
        suffix: 'product-types',
      },
      {
        name: backend.DynamoDbInventoryLotsTable,
        key: 'id',
        suffix: 'inventory-lots',
      },
    ],
  };
  assert.match(target.poolId, /^us-east-1_[A-Za-z0-9]+$/);
  assert.match(target.clientId, /^[a-z0-9]+$/);
  assert.match(
    target.direct,
    /^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com\/?$/,
  );
  for (const table of target.tables)
    assert.equal(table.name, `${selected.prefix}-${table.suffix}`);
  const config = new ConfigService({
    DYNAMODB_REGION: REGION,
    DYNAMODB_USERS_TABLE: target.tables[0].name,
    COGNITO_ISSUER: `https://cognito-idp.${REGION}.amazonaws.com/${target.poolId}`,
    COGNITO_CLIENT_ID: target.clientId,
  });
  config.skipProcessEnv = true;
  const db = new DynamoDbDocumentClientService(config);
  const lowLevelDb = new DynamoDBClient({ region: REGION });
  const cognito = new cognitoSdk.CognitoIdentityProviderClient({
    region: REGION,
  });
  const fixture = {
    households: new Set(),
    created: false,
    sub: undefined,
    access: undefined,
  };
  const passed = [];
  let phase = 'preflight';
  const pass = (name) => {
    passed.push(name);
    console.log(JSON.stringify({ check: name, status: 'PASS' }));
  };
  const step = (name) => {
    phase = name;
  };

  async function api(
    method,
    route,
    body,
    key,
    expected = 200,
    anonymous = false,
  ) {
    assert.ok(route.startsWith('/api/'));
    const response = await fetch(`${target.base}${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(35_000),
      headers: {
        ...jsonHeaders(body),
        ...(!anonymous && fixture.access
          ? {
              Cookie: `despensalista_access_token=${fixture.access}; XSRF-TOKEN=${fixture.xsrf}`,
              'x-xsrf-token': fixture.xsrf,
            }
          : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* Never print an unexpected response body. */
    }
    if (
      expected !== null &&
      !(Array.isArray(expected) ? expected : [expected]).includes(
        response.status,
      )
    ) {
      const error = new Error(
        `HTTP ${response.status}; expected ${JSON.stringify(expected)}`,
      );
      error.name = 'SmokeHttpError';
      throw error;
    }
    return {
      status: response.status,
      body: parsed,
      replayed: response.headers.get('idempotency-replayed'),
    };
  }

  async function ownRows(table) {
    if (!fixture.sub) return [];
    let cursor;
    const rows = [];
    // ponytail: bounded strong scans for small-stage QA; stop (never truncate) beyond 5,000 evaluated rows per table.
    for (let page = 0; page < 20; page++) {
      const fields = ['userId', 'ownerUserId', 'actorUserId', 'id'];
      const names = Object.fromEntries(
        fields.map((field, index) => [`#f${index}`, field]),
      );
      const values = { ':owner': fixture.sub };
      const conditions = fields.map((_, index) => `#f${index} = :owner`);
      [...fixture.households].forEach((id, index) => {
        names['#household'] = 'householdId';
        values[`:h${index}`] = id;
        conditions.push(`#household = :h${index}`);
      });
      const response = await db.send(
        new ScanCommand({
          TableName: table.name,
          ConsistentRead: true,
          Limit: 250,
          ExclusiveStartKey: cursor,
          FilterExpression: conditions.join(' OR '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      for (const item of response.Items ?? []) {
        if (item.entityType === 'HOUSEHOLD' && item.ownerUserId === fixture.sub)
          fixture.households.add(item.id);
        if (ownedCondition(item, fixture)) rows.push(item);
      }
      cursor = response.LastEvaluatedKey;
      if (!cursor) return rows;
    }
    throw new Error(
      'QA strong scan ceiling reached; no result silently truncated',
    );
  }

  async function ownSnapshot() {
    return Promise.all(
      target.tables.map(async (table) => [table, await ownRows(table)]),
    );
  }

  async function quota() {
    return (
      await db.send(
        new GetCommand({
          TableName: target.tables[0].name,
          Key: { pk: `PANTRY_QUOTA#${fixture.sub}` },
          ConsistentRead: true,
        }),
      )
    ).Item;
  }

  async function assertCounters() {
    const state = await ownSnapshot();
    const q = await quota();
    const types = state[2][1].filter(
      (item) => item.entityType === 'PRODUCT_TYPE' && !item.archivedAt,
    );
    const lots = state[3][1].filter(
      (item) => item.entityType === 'INVENTORY_LOT' && !item.archivedAt,
    );
    const lists = state[0][1].filter(
      (item) => item.entityType === 'SHOPPING_LIST',
    );
    assert.equal(q.activeProductTypes, types.length);
    assert.equal(q.activeInventoryLots, lots.length);
    assert.equal(q.savedShoppingLists, lists.length);
    for (const [id, count] of Object.entries(q.lotsByProductType))
      assert.equal(
        count,
        lots.filter((lot) => lot.productTypeId === id).length,
      );
    for (const lot of lots)
      assert.ok(q.lotsByProductType[lot.productTypeId] > 0);
    assert.equal(Object.keys(q.productTypeNames).length, types.length);
    return state;
  }

  async function eventually(read, check) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const value = await read();
      if (check(value)) return value;
      await delay(500);
    }
    throw new Error('Read-after-write convergence timeout');
  }

  async function forceQuota(field, limit, action) {
    const before = await quota();
    assert.equal(before.ownerUserId, fixture.sub);
    const update = (from, to) =>
      db.send(
        new UpdateCommand({
          TableName: target.tables[0].name,
          Key: { pk: before.pk },
          UpdateExpression: 'SET #field = :to',
          ConditionExpression: 'ownerUserId = :owner AND #field = :from',
          ExpressionAttributeNames: { '#field': field },
          ExpressionAttributeValues: {
            ':owner': fixture.sub,
            ':from': from,
            ':to': to,
          },
        }),
      );
    await update(before[field], limit);
    try {
      await action();
    } finally {
      await update(limit, before[field]);
    }
    await assertCounters();
  }

  async function cleanupFallback() {
    if (fixture.sub) {
      // Every delete includes the exact primary key AND ownership read from this fixture.
      for (const [table, rows] of await ownSnapshot()) {
        for (const row of rows) {
          // Keep only the product's minimal, self-expiring revocation marker.
          if (minimalDeletionMarker(row, fixture.sub)) continue;
          const owner = ownedCondition(row, fixture);
          assert.ok(owner && row[table.key]);
          await db.send(
            new DeleteCommand({
              TableName: table.name,
              Key: { [table.key]: row[table.key] },
              ConditionExpression: '#owner = :owner AND #kind = :kind',
              ExpressionAttributeNames: {
                '#owner': owner.field,
                '#kind': 'entityType',
              },
              ExpressionAttributeValues: {
                ':owner': owner.value,
                ':kind': row.entityType,
              },
            }),
          );
        }
      }
    }
    if (fixture.created) {
      try {
        const user = await cognito.send(
          new cognitoSdk.AdminGetUserCommand({
            UserPoolId: target.poolId,
            Username: fixture.username,
          }),
        );
        const attrs = Object.fromEntries(
          user.UserAttributes.map((item) => [item.Name, item.Value]),
        );
        assert.equal(attrs.email, fixture.email);
        if (fixture.sub) assert.equal(attrs.sub, fixture.sub);
        await cognito.send(
          new cognitoSdk.AdminDeleteUserCommand({
            UserPoolId: target.poolId,
            Username: fixture.username,
          }),
        );
      } catch (error) {
        if (error.name !== 'UserNotFoundException') throw error;
      }
    }
  }

  async function assertDeleted() {
    const remaining = (await ownSnapshot()).flatMap(([, rows]) => rows);
    assert.ok(
      remaining.every((row) => minimalDeletionMarker(row, fixture.sub)),
      'Fixture content remains beyond the minimal deletion marker',
    );
    if (fixture.accountDeleted) assert.equal(remaining.length, 0);
    for (const pk of revocationKeys(fixture.sub ?? '')) {
      if (!fixture.sub) break;
      const { Item: marker } = await db.send(
        new GetCommand({
          TableName: target.tables[0].name,
          Key: { pk },
          ConsistentRead: true,
        }),
      );
      if (!marker && !fixture.accountDeleted) continue;
      assert.ok(marker);
      assert.equal(marker.entityType, 'ACCOUNT_REVOCATION');
      assert.deepEqual(
        Object.keys(marker).sort(),
        ['pk', 'entityType', 'expiresAt', 'expiresAtEpochSeconds'].sort(),
      );
      const expiresAt = new Date(marker.expiresAt).getTime();
      assert.ok(
        expiresAt > Date.now() && expiresAt <= Date.now() + 86400_000 + 60_000,
      );
      assert.equal(marker.expiresAtEpochSeconds, Math.floor(expiresAt / 1000));
    }
    await assert.rejects(
      cognito.send(
        new cognitoSdk.AdminGetUserCommand({
          UserPoolId: target.poolId,
          Username: fixture.username,
        }),
      ),
      { name: 'UserNotFoundException' },
    );
  }

  let failure;
  try {
    for (const table of target.tables) {
      const description = await lowLevelDb.send(
        new DescribeTableCommand({ TableName: table.name }),
      );
      assert.equal(
        description.Table.TableArn,
        `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${table.name}`,
      );
      assert.equal(description.Table.TableStatus, 'ACTIVE');
    }
    const pool = await cognito.send(
      new cognitoSdk.DescribeUserPoolCommand({ UserPoolId: target.poolId }),
    );
    assert.equal(
      pool.UserPool.Arn,
      `arn:aws:cognito-idp:${REGION}:${ACCOUNT}:userpool/${target.poolId}`,
    );
    const mfa = await cognito.send(
      new cognitoSdk.GetUserPoolMfaConfigCommand({ UserPoolId: target.poolId }),
    );
    assert.equal(mfa.MfaConfiguration, 'ON');
    assert.equal(mfa.SoftwareTokenMfaConfiguration.Enabled, true);
    const client = await cognito.send(
      new cognitoSdk.DescribeUserPoolClientCommand({
        UserPoolId: target.poolId,
        ClientId: target.clientId,
      }),
    );
    assert.ok(
      client.UserPoolClient.ExplicitAuthFlows.includes('ALLOW_USER_SRP_AUTH'),
    );
    assert.equal(client.UserPoolClient.ClientSecret, undefined);
    pass(phase);

    step('health-and-origin-protection');
    await api('GET', '/api/healthz', undefined, undefined, 200, true);
    await api('GET', '/api/profile', undefined, undefined, 401, true);
    const direct = await fetch(
      `${target.direct.replace(/\/$/, '')}/api/healthz`,
      { redirect: 'error', signal: AbortSignal.timeout(35_000) },
    );
    assert.equal(direct.status, 403);
    await direct.arrayBuffer();
    pass(phase);

    step('cognito-srp-mandatory-totp');
    fixture.email = `audit-${randomUUID()}@example.invalid`;
    fixture.password = `Qa!7${randomBytes(32).toString('base64url')}`;
    fixture.xsrf = randomBytes(24).toString('hex');
    fixture.username = fixture.email;
    await assert.rejects(
      cognito.send(
        new cognitoSdk.AdminGetUserCommand({
          UserPoolId: target.poolId,
          Username: fixture.username,
        }),
      ),
      { name: 'UserNotFoundException' },
    );
    // Arm cleanup before sending: create may commit even when its response is lost.
    fixture.created = true;
    const created = await cognito.send(
      new cognitoSdk.AdminCreateUserCommand({
        UserPoolId: target.poolId,
        Username: fixture.email,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: fixture.password,
        UserAttributes: [
          { Name: 'email', Value: fixture.email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: fixture.email.split('@')[0] },
        ],
      }),
    );
    fixture.username = created.User.Username;
    fixture.sub = created.User.Attributes.find(
      (attribute) => attribute.Name === 'sub',
    ).Value;
    await cognito.send(
      new cognitoSdk.AdminSetUserPasswordCommand({
        UserPoolId: target.poolId,
        Username: fixture.username,
        Password: fixture.password,
        Permanent: true,
      }),
    );
    await signIn(srp, target, fixture, true);
    const tokens = await signIn(srp, target, fixture, false);
    const verifier = new CognitoTokenVerifierService(config);
    const [claims, accessClaims] = await Promise.all([
      verifier.verifyIdToken(tokens.id),
      verifier.verifyAccessToken(tokens.access),
    ]);
    assert.equal(claims.sub, fixture.sub);
    assert.equal(accessClaims.sub, fixture.sub);
    assert.equal(claims.email, fixture.email);
    fixture.access = tokens.access;
    const dao = new DynamoDbUserDao(db, config);
    assert.equal(await dao.findByEmail(fixture.email), null);
    assert.equal(await dao.findByAuthSubject(fixture.sub), null);
    // Fixture only: this deliberately does NOT test browser OAuth callback/state/PKCE.
    const user = await new CognitoProfileSyncService(dao).syncFromClaims(
      claims,
    );
    assert.equal(user.id.toString(), fixture.sub);
    await eventually(
      () => api('GET', '/api/profile', undefined, undefined, null),
      (result) => result.status === 200,
    );
    pass(phase);

    step('product-types-lots-and-unique-name');
    const typeBody = {
      baseName: `QA arroz ${randomUUID().slice(0, 8)}`,
      category: 'food',
      defaultUnit: 'piezas',
    };
    const type = (
      await api('POST', '/api/product-types', typeBody, undefined, 201)
    ).body;
    const secondType = (
      await api(
        'POST',
        '/api/product-types',
        { ...typeBody, baseName: `QA frijol ${randomUUID().slice(0, 8)}` },
        undefined,
        201,
      )
    ).body;
    await api('POST', '/api/product-types', typeBody, undefined, [400, 409]);
    const lotBody = { productTypeId: type.id, quantity: 8, unit: 'piezas' };
    const lot = (
      await api('POST', '/api/inventory-lots', lotBody, undefined, 201)
    ).body;
    await eventually(
      () => api('GET', '/api/inventory-lots/page'),
      (result) => result.body.items.some((item) => item.id === lot.id),
    );
    await assertCounters();
    pass(phase);

    step('consume-waste-replay-collision');
    for (const body of [
      { quantity: 1 },
      { quantity: 1, wasteReason: 'expired' },
    ]) {
      const key = randomUUID();
      const first = await api(
        'POST',
        `/api/inventory-lots/${lot.id}/consume`,
        body,
        key,
        201,
      );
      const replay = await api(
        'POST',
        `/api/inventory-lots/${lot.id}/consume`,
        body,
        key,
        201,
      );
      assert.equal(replay.replayed, 'true');
      assert.deepEqual(replay.body, first.body);
      await api(
        'POST',
        `/api/inventory-lots/${lot.id}/consume`,
        { ...body, quantity: 2 },
        key,
        409,
      );
    }
    const state = await assertCounters();
    assert.equal(state[3][1].find((item) => item.id === lot.id).quantity, 6);
    assert.equal(
      state
        .flatMap(([, rows]) => rows)
        .filter((item) => item.entityType === 'WASTE_EVENT').length,
      1,
    );
    pass(phase);

    step('concurrent-consumption-and-same-key');
    const raceLot = (
      await api(
        'POST',
        '/api/inventory-lots',
        { ...lotBody, quantity: 3 },
        undefined,
        201,
      )
    ).body;
    const race = await Promise.all(
      [1, 2].map(() =>
        api(
          'POST',
          `/api/inventory-lots/${raceLot.id}/consume`,
          { quantity: 2 },
          randomUUID(),
          null,
        ),
      ),
    );
    assert.equal(race.filter((item) => item.status === 201).length, 1);
    assert.ok(race.every((item) => [201, 400, 409].includes(item.status)));
    const raceState = await assertCounters();
    assert.equal(
      raceState[3][1].find((item) => item.id === raceLot.id).quantity,
      1,
    );
    const key = randomUUID();
    const sameKey = await Promise.all(
      [1, 2].map(() =>
        api(
          'POST',
          `/api/inventory-lots/${lot.id}/consume`,
          { quantity: 1, wasteReason: 'expired' },
          key,
          201,
        ),
      ),
    );
    assert.deepEqual(sameKey[0].body, sameKey[1].body);
    assert.ok(sameKey.some((item) => item.replayed === 'true'));
    const sameState = await assertCounters();
    assert.equal(
      sameState[3][1].find((item) => item.id === lot.id).quantity,
      5,
    );
    assert.equal(
      sameState
        .flatMap(([, rows]) => rows)
        .filter((item) => item.entityType === 'WASTE_EVENT').length,
      2,
    );
    pass(phase);

    step('checkout-replay-collision-and-invalid-line-rollback');
    const checkout = {
      items: [
        {
          productTypeId: type.id,
          quantity: 2,
          unit: 'piezas',
          paidUnitPrice: 15,
        },
        {
          productTypeId: secondType.id,
          quantity: 1,
          unit: 'piezas',
          paidUnitPrice: 20,
        },
      ],
    };
    const buyKey = randomUUID();
    const bought = await api(
      'POST',
      '/api/pantry/checkout',
      checkout,
      buyKey,
      201,
    );
    assert.equal(bought.body.length, 2);
    const boughtAgain = await api(
      'POST',
      '/api/pantry/checkout',
      checkout,
      buyKey,
      201,
    );
    assert.equal(boughtAgain.replayed, 'true');
    assert.deepEqual(boughtAgain.body, bought.body);
    await api(
      'POST',
      '/api/pantry/checkout',
      { items: [{ ...checkout.items[0], quantity: 3 }] },
      buyKey,
      409,
    );
    const beforeInvalid = await assertCounters();
    await api(
      'POST',
      '/api/pantry/checkout',
      {
        items: [
          checkout.items[0],
          { ...checkout.items[1], productTypeId: randomUUID() },
        ],
      },
      randomUUID(),
      404,
    );
    const afterInvalid = await assertCounters();
    for (const index of [1, 2, 3])
      assert.deepEqual(
        afterInvalid[index][1].sort((a, b) => a.id.localeCompare(b.id)),
        beforeInvalid[index][1].sort((a, b) => a.id.localeCompare(b.id)),
      );
    assert.equal(
      afterInvalid[0][1].filter(
        (item) => item.entityType === 'PANTRY_OPERATION',
      ).length,
      beforeInvalid[0][1].filter(
        (item) => item.entityType === 'PANTRY_OPERATION',
      ).length,
    );
    await api(
      'POST',
      '/api/pantry/checkout',
      { items: Array.from({ length: 50 }, () => checkout.items[0]) },
      randomUUID(),
      400,
    );
    for (const receipt of afterInvalid[0][1].filter(
      (item) => item.entityType === 'PANTRY_OPERATION',
    )) {
      assert.ok(
        Math.abs(
          new Date(receipt.expiresAt) -
            new Date(receipt.createdAt) -
            7 * 86400_000,
        ) < 1000,
      );
      assert.equal(
        receipt.expiresAtEpochSeconds,
        Math.floor(new Date(receipt.expiresAt).getTime() / 1000),
      );
    }
    pass(phase);

    step('expired-retained-receipt-conflicts-without-reexecuting');
    const receipt = afterInvalid[0][1].find(
      (item) =>
        item.entityType === 'PANTRY_OPERATION' &&
        Array.isArray(item.response) &&
        item.response[0]?.id === bought.body[0].id,
    );
    assert.ok(receipt);
    const expired = new Date(Date.now() - 1000).toISOString();
    const setReceiptExpiry = (from, to) =>
      db.send(
        new UpdateCommand({
          TableName: target.tables[0].name,
          Key: { pk: receipt.pk },
          UpdateExpression: 'SET expiresAt = :to',
          ConditionExpression: 'ownerUserId = :owner AND expiresAt = :from',
          ExpressionAttributeValues: {
            ':owner': fixture.sub,
            ':from': from,
            ':to': to,
          },
        }),
      );
    // Preserve the future TTL epoch to model a physically retained expired receipt.
    await setReceiptExpiry(receipt.expiresAt, expired);
    try {
      await api('POST', '/api/pantry/checkout', checkout, buyKey, 409);
      const unchanged = await ownRows(target.tables[3]);
      assert.deepEqual(
        unchanged.map((item) => item.id).sort(),
        afterInvalid[3][1].map((item) => item.id).sort(),
      );
    } finally {
      await setReceiptExpiry(expired, receipt.expiresAt);
    }
    pass(phase);

    step('quota-boundaries-transaction-rollback-and-pagination');
    await forceQuota(
      'activeProductTypes',
      limits.MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
      () =>
        api(
          'POST',
          '/api/product-types',
          { ...typeBody, baseName: 'QA blocked quota' },
          undefined,
          [400, 409],
        ),
    );
    await forceQuota(
      'activeInventoryLots',
      limits.MAX_ACTIVE_INVENTORY_LOTS_PER_USER,
      async () => {
        const before = await ownRows(target.tables[3]);
        await api(
          'POST',
          '/api/inventory-lots',
          lotBody,
          undefined,
          [400, 409],
        );
        await api(
          'POST',
          '/api/pantry/checkout',
          checkout,
          randomUUID(),
          [400, 409],
        );
        const after = await ownRows(target.tables[3]);
        assert.deepEqual(
          after.map((item) => item.id).sort(),
          before.map((item) => item.id).sort(),
        );
      },
    );
    const listBody = {
      title: 'QA saved shopping list',
      items: [
        {
          productTypeId: type.id,
          baseName: type.baseName,
          quantity: 1,
          unit: 'piezas',
        },
      ],
    };
    const list = (
      await api('POST', '/api/pantry/shopping-lists', listBody, undefined, 201)
    ).body;
    await forceQuota(
      'savedShoppingLists',
      limits.MAX_SAVED_SHOPPING_LISTS_PER_USER,
      () =>
        api(
          'POST',
          '/api/pantry/shopping-lists',
          listBody,
          undefined,
          [400, 409],
        ),
    );
    await api(
      'DELETE',
      `/api/pantry/shopping-lists/${list.id}`,
      undefined,
      undefined,
      [200, 204],
    );
    await assertCounters();
    await eventually(
      () => api('GET', '/api/product-types/page?limit=1'),
      (result) => result.body.pagination.hasMore === true,
    );
    for (const route of ['product-types', 'inventory-lots']) {
      const seen = new Set();
      let cursor;
      for (let page = 0; page < 20; page++) {
        const result = (
          await api(
            'GET',
            `/api/${route}/page?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          )
        ).body;
        assert.equal(result.pagination.limit, 1);
        for (const item of result.items) {
          assert.ok(!seen.has(item.id));
          seen.add(item.id);
        }
        if (!result.pagination.hasMore) break;
        assert.ok(result.pagination.nextCursor);
        cursor = result.pagination.nextCursor;
        assert.ok(page < 19, 'Pagination must terminate');
      }
      const table = target.tables[route === 'product-types' ? 2 : 3];
      const entityType =
        route === 'product-types' ? 'PRODUCT_TYPE' : 'INVENTORY_LOT';
      assert.deepEqual(
        [...seen].sort(),
        activeEntityIds(await ownRows(table), entityType),
      );
      await api(
        'GET',
        `/api/${route}/page?limit=101`,
        undefined,
        undefined,
        400,
      );
      await api(
        'GET',
        `/api/${route}/page?cursor=invalid`,
        undefined,
        undefined,
        400,
      );
    }
    pass(phase);

    step('archive-restore-counter-coherence');
    for (const [route, id] of [
      ['inventory-lots', lot.id],
      ['product-types', secondType.id],
    ]) {
      await api(
        'POST',
        `/api/${route}/${id}/archive`,
        { reason: 'Temporary deployment QA' },
        undefined,
        201,
      );
      await assertCounters();
      await api('POST', `/api/${route}/${id}/restore`, {}, undefined, 201);
      await assertCounters();
    }
    pass(phase);

    step('delete-account-removes-cognito-and-all-fixture-data');
    await api('DELETE', '/api/profile/account', {
      confirmationText: 'ELIMINAR CUENTA',
    });
    fixture.accountDeleted = true;
    await api('GET', '/api/profile', undefined, undefined, 401);
    await assertDeleted();
    pass(phase);
  } catch (error) {
    failure = {
      phase,
      error: /^[A-Za-z0-9_]+$/.test(error.name ?? '') ? error.name : 'Error',
    };
    if (error.name === 'SmokeHttpError') failure.detail = error.message;
  } finally {
    try {
      await cleanupFallback();
      if (fixture.created) await assertDeleted();
    } catch (error) {
      failure = {
        ...(failure ?? { phase: 'cleanup' }),
        cleanupFailed: true,
        fixtureUsername: fixture.username,
        fixtureSub: fixture.sub,
        cleanupError: /^[A-Za-z0-9_]+$/.test(error.name ?? '')
          ? error.name
          : 'Error',
      };
    }
    fixture.password = undefined;
    fixture.access = undefined;
    fixture.totpSecret = undefined;
    db.client.destroy();
    lowLevelDb.destroy();
    cognito.destroy();
  }
  console.log(
    JSON.stringify({
      stage,
      passed: passed.length,
      status: failure ? 'FAIL' : 'PASS',
      ...(failure ?? {}),
      oauthBrowserCallbackTested: false,
    }),
  );
  if (failure) process.exitCode = 1;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    console.log(
      'Usage: node scripts/deployed-api-smoke.cjs --stage dev|tst|prod --run\nRequires npm run build, AWS credentials and COGNITO_TEST_SRP_MODULE_PATH (test-only package outside repo).\nNo AWS operation is performed without --run. See scripts/DEPLOYED_API_SMOKE.md.',
    );
  } else if (
    args.length === 3 &&
    args[0] === '--stage' &&
    args[2] === '--run'
  ) {
    run(args[1]).catch((error) => {
      console.error(
        JSON.stringify({
          status: 'FAIL',
          phase: 'preflight',
          error: /^[A-Za-z0-9_]+$/.test(error.name ?? '')
            ? error.name
            : 'Error',
        }),
      );
      process.exitCode = 1;
    });
  } else {
    console.error('Only --stage dev|tst|prod --run is accepted; use --help.');
    process.exitCode = 1;
  }
}

module.exports = {
  resolveStage,
  totp,
  ownedCondition,
  minimalDeletionMarker,
  revocationKeys,
  jsonHeaders,
  activeEntityIds,
};
