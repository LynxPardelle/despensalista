import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const handlerPath = path.join(
  __dirname,
  '..',
  'lambda',
  'cognito-email-quota',
  'index.js',
);

const environment = {
  TABLE_NAME: 'quota-table',
  DAILY_LIMIT: '30',
  RECOVERY_RESERVE: '10',
  RECIPIENT_LIMIT: '5',
};

function loadHandler(): any {
  assert.equal(
    fs.existsSync(handlerPath),
    true,
    'the Cognito email quota handler must exist',
  );
  return require(handlerPath);
}

function event(triggerSource: string, email = ' Alice@Example.COM '): any {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'us-east-1_example',
    userName: 'user-id',
    callerContext: { awsSdkVersion: '3', clientId: 'client-id' },
    triggerSource,
    request: {
      userAttributes: { email },
      codeParameter: '{####}',
      usernameParameter: '{username}',
    },
    response: {},
  };
}

function updateDetails(input: any): Array<{ key: string; limit: number; expiresAt: number }> {
  return input.TransactItems.map(({ Update }: any) => ({
    key: Update.Key.key.S,
    limit: Number(Update.ExpressionAttributeValues[':limit'].N),
    expiresAt: Number(Update.ExpressionAttributeValues[':expiresAt'].N),
  }));
}

test('meters every Cognito flow that can send managed email without customizing it', async () => {
  const { createHandler } = loadHandler();
  const inputs: any[] = [];
  const handler = createHandler({
    environment,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async (input: any) => inputs.push(input),
  });
  const triggerSources = [
    'CustomMessage_SignUp',
    'CustomMessage_ResendCode',
    'CustomMessage_ForgotPassword',
    'CustomMessage_UpdateUserAttribute',
    'CustomMessage_VerifyUserAttribute',
    'CustomMessage_AdminCreateUser',
  ];

  for (const triggerSource of triggerSources) {
    const inputEvent = event(triggerSource);
    const result = await handler(inputEvent);

    assert.strictEqual(result, inputEvent);
    assert.deepEqual(result.response, {});
  }

  assert.equal(inputs.length, triggerSources.length);
});

test('reserves ten production sends for recovery while enforcing the total and recipient caps', async () => {
  const { createHandler } = loadHandler();
  const inputs: any[] = [];
  const handler = createHandler({
    environment,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async (input: any) => inputs.push(input),
  });

  await handler(event('CustomMessage_SignUp'));
  await handler(event('CustomMessage_ForgotPassword'));

  const standard = updateDetails(inputs[0]);
  const recovery = updateDetails(inputs[1]);
  for (const input of inputs) {
    for (const { Update } of input.TransactItems) {
      assert.equal(
        Update.ConditionExpression,
        'attribute_not_exists(#used) OR #used < :limit',
      );
      assert.match(Update.UpdateExpression, /if_not_exists/);
    }
  }
  assert.deepEqual(standard.map(({ limit }) => limit).sort((a, b) => a - b), [5, 20, 30]);
  assert.deepEqual(recovery.map(({ limit }) => limit).sort((a, b) => a - b), [5, 30]);
  assert.equal(standard.some(({ key }) => key.endsWith('#standard')), true);
  assert.equal(recovery.some(({ key }) => key.endsWith('#standard')), false);
});

test('dev allows signup and recovery for the same recipient within the two-send daily limit', async () => {
  const { createHandler } = loadHandler();
  const used = new Map<string, number>();
  const handler = createHandler({
    environment: { ...environment, DAILY_LIMIT: '2', RECOVERY_RESERVE: '1', RECIPIENT_LIMIT: '2' },
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    logFailure: () => undefined,
    transactWrite: async (input: any) => {
      const counters = updateDetails(input);
      if (counters.some(({ key, limit }) => (used.get(key) ?? 0) >= limit)) {
        throw new Error('Transaction cancelled');
      }
      for (const { key } of counters) used.set(key, (used.get(key) ?? 0) + 1);
    },
  });
  const signup = event('CustomMessage_SignUp');
  const recovery = event('CustomMessage_ForgotPassword', 'alice@example.com');

  assert.equal(await handler(signup), signup);
  await assert.rejects(handler(event('CustomMessage_SignUp', 'bob@example.com')));
  assert.equal(await handler(recovery), recovery);
  await assert.rejects(handler(event('CustomMessage_ForgotPassword', 'bob@example.com')));
  assert.deepEqual([...used.values()].sort((a, b) => a - b), [1, 2, 2]);
});

test('hashes normalized recipients and never stores their email address', async () => {
  const { createHandler } = loadHandler();
  const inputs: any[] = [];
  const handler = createHandler({
    environment,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async (input: any) => inputs.push(input),
  });

  await handler(event('CustomMessage_ResendCode', ' Alice@Example.COM '));
  await handler(event('CustomMessage_ResendCode', 'alice@example.com'));

  const recipientKeys = inputs.map((input) =>
    updateDetails(input).find(({ key }) => key.includes('#recipient#'))!.key,
  );
  assert.equal(recipientKeys[0], recipientKeys[1]);
  assert.doesNotMatch(JSON.stringify(inputs), /alice|example\.com/i);
});

test('starts a new daily quota window exactly at 09:00 UTC and attaches TTL', async () => {
  const { createHandler } = loadHandler();
  const inputs: any[] = [];
  let clock = new Date('2026-09-26T08:59:59.999Z');
  const handler = createHandler({
    environment,
    now: () => clock,
    transactWrite: async (input: any) => inputs.push(input),
  });

  await handler(event('CustomMessage_SignUp'));
  clock = new Date('2026-09-26T09:00:00.000Z');
  await handler(event('CustomMessage_SignUp'));

  const previous = updateDetails(inputs[0]);
  const current = updateDetails(inputs[1]);
  const previousStart = Date.parse('2026-09-25T09:00:00.000Z') / 1000;
  const currentStart = Date.parse('2026-09-26T09:00:00.000Z') / 1000;
  assert.equal(previous[0].key.startsWith(`window#${previousStart}#`), true);
  assert.equal(current[0].key.startsWith(`window#${currentStart}#`), true);
  assert.equal(current.every(({ expiresAt }) => expiresAt > currentStart + 86_400), true);
});

test('does not meter TOTP authentication messages', async () => {
  const { createHandler } = loadHandler();
  let writes = 0;
  const handler = createHandler({
    environment,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async () => { writes += 1; },
  });
  const inputEvent = event('CustomMessage_Authentication');

  assert.strictEqual(await handler(inputEvent), inputEvent);
  assert.equal(writes, 0);
});

test('fails closed without a recipient and sanitizes DynamoDB failures', async () => {
  const { createHandler } = loadHandler();
  const categories: string[] = [];
  const logFailure = (category: string) => categories.push(category);
  const missingRecipient = createHandler({
    environment,
    logFailure,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async () => undefined,
  });
  const unavailableStore = createHandler({
    environment,
    logFailure,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async () => { throw new Error('sensitive DynamoDB detail'); },
  });

  await assert.rejects(
    missingRecipient(event('CustomMessage_SignUp', '   ')),
    /El envío de correo no está disponible por el momento/,
  );
  await assert.rejects(
    unavailableStore(event('CustomMessage_ForgotPassword')),
    (error: Error) => {
      assert.match(error.message, /El envío de correo no está disponible por el momento/);
      assert.doesNotMatch(error.message, /DynamoDB|sensitive/);
      return true;
    },
  );
  assert.deepEqual(categories, ['missing_recipient', 'unexpected_failure']);
});

test('reports whether a transaction hit quota, lacked permission or had another failure', async () => {
  const { createHandler } = loadHandler();
  const categories: string[] = [];
  const cases = [
    { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed', Item: { email: 'alice@example.test' } }] },
    { name: 'AccessDeniedException' },
    { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] },
    { name: 'ThrottlingException' },
    { name: 'ResourceNotFoundException' },
  ];
  for (const failure of cases) {
    const handler = createHandler({
      environment,
      logFailure: (category: string) => categories.push(category),
      transactWrite: async () => { throw { ...failure, message: 'alice@example.test', requestId: 'private' }; },
    });
    await assert.rejects(handler(event('CustomMessage_SignUp')), {
      message: 'El envío de correo no está disponible por el momento. Vuelve a intentarlo más tarde.',
    });
  }
  assert.deepEqual(categories, ['quota_exceeded', 'storage_access_denied', 'transaction_cancelled', 'storage_throttled', 'storage_missing']);
});
