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
  const missingRecipient = createHandler({
    environment,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async () => undefined,
  });
  const unavailableStore = createHandler({
    environment,
    now: () => new Date('2026-09-26T12:00:00.000Z'),
    transactWrite: async () => { throw new Error('sensitive DynamoDB detail'); },
  });

  await assert.rejects(
    missingRecipient(event('CustomMessage_SignUp', '   ')),
    /Email delivery temporarily unavailable/,
  );
  await assert.rejects(
    unavailableStore(event('CustomMessage_ForgotPassword')),
    (error: Error) => {
      assert.match(error.message, /Email delivery temporarily unavailable/);
      assert.doesNotMatch(error.message, /DynamoDB|sensitive/);
      return true;
    },
  );
});
