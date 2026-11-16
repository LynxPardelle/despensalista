'use strict';

const { createHash } = require('node:crypto');

const DAY_SECONDS = 86_400;
const WINDOW_START_SECONDS = 9 * 60 * 60;
const ERROR_MESSAGE = 'El envío de correo no está disponible por el momento. Vuelve a intentarlo más tarde.';
const RECOVERY_TRIGGER = 'CustomMessage_ForgotPassword';
const METERED_TRIGGERS = new Set([
  'CustomMessage_SignUp',
  'CustomMessage_ResendCode',
  RECOVERY_TRIGGER,
  'CustomMessage_UpdateUserAttribute',
  'CustomMessage_VerifyUserAttribute',
  'CustomMessage_AdminCreateUser',
]);

function positiveInteger(value, name) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readConfiguration(environment) {
  const dailyLimit = positiveInteger(environment.DAILY_LIMIT, 'DAILY_LIMIT');
  const recoveryReserve = positiveInteger(
    environment.RECOVERY_RESERVE,
    'RECOVERY_RESERVE',
  );
  const recipientLimit = positiveInteger(
    environment.RECIPIENT_LIMIT,
    'RECIPIENT_LIMIT',
  );

  if (!environment.TABLE_NAME || recoveryReserve >= dailyLimit) {
    throw new Error('Invalid email quota configuration');
  }

  return {
    dailyLimit,
    recoveryReserve,
    recipientLimit,
    tableName: environment.TABLE_NAME,
  };
}

function counterUpdate(tableName, key, limit, expiresAt) {
  return {
    Update: {
      TableName: tableName,
      Key: { key: { S: key } },
      UpdateExpression:
        'SET #used = if_not_exists(#used, :zero) + :one, #expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(#used) OR #used < :limit',
      ExpressionAttributeNames: {
        '#used': 'used',
        '#expiresAt': 'expiresAt',
      },
      ExpressionAttributeValues: {
        ':zero': { N: '0' },
        ':one': { N: '1' },
        ':limit': { N: String(limit) },
        ':expiresAt': { N: String(expiresAt) },
      },
    },
  };
}

function describeFailure(error) {
  switch (error?.name) {
    case 'AccessDeniedException':
    case 'AccessDenied':
      return 'storage_access_denied';
    case 'TransactionCanceledException':
      return Array.isArray(error.CancellationReasons)
        && error.CancellationReasons.some((reason) => reason?.Code === 'ConditionalCheckFailed')
        ? 'quota_exceeded'
        : 'transaction_cancelled';
    case 'ProvisionedThroughputExceededException':
    case 'ThrottlingException':
    case 'RequestLimitExceeded':
      return 'storage_throttled';
    case 'ResourceNotFoundException':
      return 'storage_missing';
    default:
      return 'unexpected_failure';
  }
}

function createHandler({
  transactWrite,
  now = () => new Date(),
  environment = process.env,
  logFailure = (category) => console.warn('Cognito email quota request rejected', { category }),
}) {
  const config = readConfiguration(environment);

  return async (event) => {
    if (!METERED_TRIGGERS.has(event?.triggerSource)) {
      return event;
    }

    const recipient = event.request?.userAttributes?.email;
    if (typeof recipient !== 'string' || !recipient.trim()) {
      logFailure('missing_recipient');
      throw new Error(ERROR_MESSAGE);
    }

    try {
      const email = recipient.trim().toLowerCase();
      const nowSeconds = Math.floor(now().getTime() / 1000);
      const windowStart =
        Math.floor((nowSeconds - WINDOW_START_SECONDS) / DAY_SECONDS) * DAY_SECONDS
        + WINDOW_START_SECONDS;
      // Keep expired counters briefly; the window key, not TTL timing, resets quota.
      const expiresAt = windowStart + 3 * DAY_SECONDS;
      const prefix = `window#${windowStart}`;
      const recipientHash = createHash('sha256').update(email).digest('hex');
      const transactItems = [
        counterUpdate(config.tableName, `${prefix}#total`, config.dailyLimit, expiresAt),
      ];

      if (event.triggerSource !== RECOVERY_TRIGGER) {
        transactItems.push(counterUpdate(
          config.tableName,
          `${prefix}#standard`,
          config.dailyLimit - config.recoveryReserve,
          expiresAt,
        ));
      }

      transactItems.push(counterUpdate(
        config.tableName,
        `${prefix}#recipient#${recipientHash}`,
        config.recipientLimit,
        expiresAt,
      ));

      await transactWrite({ TransactItems: transactItems });
      return event;
    } catch (error) {
      logFailure(describeFailure(error));
      throw new Error(ERROR_MESSAGE);
    }
  };
}

let client;
let runtimeHandler;

async function transactWrite(input) {
  const { DynamoDBClient, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');
  client ??= new DynamoDBClient({ maxAttempts: 2 });
  await client.send(new TransactWriteItemsCommand(input));
}

exports.createHandler = createHandler;
exports.handler = async (event) => {
  runtimeHandler ??= createHandler({ transactWrite });
  return runtimeHandler(event);
};
