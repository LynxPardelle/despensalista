import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { User } from '../../../domain/entities/user.entity';
import { UserAccountStatus } from '../../../domain/enums';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbUserDao } from './dynamodb-user.dao';

describe('DynamoDbUserDao account revocation', () => {
  it('returns the durable deletion fence used to reject existing sessions', async () => {
    const account = user();
    const send = jest.fn().mockResolvedValue({
      Item: {
        ...account.toPrimitives(),
        pk: 'USER#local-id',
        entityType: 'USER',
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
        deletionFenceExpiresAt: '9999-12-31T23:59:59.999Z',
      },
    });

    const found = await createDao(send).findById(account.id);

    expect(found?.isAccountDeletionPending()).toBe(true);
  });

  it('conditions profile writes on revocation fences in the same transaction', async () => {
    const send = jest.fn().mockResolvedValue({});
    const dao = createDao(send);
    await dao.save(user());
    const transaction = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    const checks = transaction.input.TransactItems?.filter((item) => {
      const pk = item.ConditionCheck?.Key?.pk;
      return typeof pk === 'string' && pk.startsWith('ACCOUNT_REVOCATION#');
    });
    expect(checks).toHaveLength(3);
    expect(
      checks?.every(
        (item) =>
          item.ConditionCheck?.ConditionExpression ===
          'attribute_not_exists(pk)',
      ),
    ).toBe(true);
    expect((send.mock.calls[0][0] as GetCommand).input.ConsistentRead).toBe(
      true,
    );
  });

  it('deletes profile and lookup keys atomically with anonymous one-day revocations', async () => {
    const account = user();
    const send = jest.fn().mockImplementation(async (command) =>
      command instanceof GetCommand
        ? {
            Item: {
              ...account.toPrimitives(),
              pk: `USER#${account.id.toString()}`,
              entityType: 'USER',
              createdAt: account.createdAt.toISOString(),
              updatedAt: account.updatedAt.toISOString(),
            },
          }
        : {},
    );
    await createDao(send).delete(account.id);
    const transaction = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    const markers = transaction.input.TransactItems?.filter(
      (item) => item.Put?.Item?.entityType === 'ACCOUNT_REVOCATION',
    );
    expect(markers).toHaveLength(3);
    for (const marker of markers ?? []) {
      expect(Object.keys(marker.Put!.Item!).sort()).toEqual([
        'entityType',
        'expiresAt',
        'expiresAtEpochSeconds',
        'pk',
      ]);
      expect(marker.Put!.Item!.expiresAtEpochSeconds).toBeGreaterThan(
        Date.now() / 1000 + 23 * 60 * 60,
      );
      expect(JSON.stringify(marker)).not.toContain('owner@example.com');
    }
    expect(
      transaction.input.TransactItems?.some(
        (item) => item.Delete?.Key?.pk === 'USER#local-id',
      ),
    ).toBe(true);
  });

  it('persists an immutable deletion job before external identity cleanup', async () => {
    const account = user();
    const send = jest.fn().mockImplementation(async (command) =>
      command instanceof GetCommand && command.input.Key?.pk === 'USER#local-id'
        ? {
            Item: {
              ...account.toPrimitives(),
              pk: 'USER#local-id',
              entityType: 'USER',
              createdAt: account.createdAt.toISOString(),
              updatedAt: account.updatedAt.toISOString(),
            },
          }
        : {},
    );
    const dao = createDao(send);

    await expect(
      dao.beginAccountDeletion(
        account.id,
        new Date('9999-12-31T23:59:59.999Z'),
        { householdId: 'household-1', householdRole: 'editor' },
      ),
    ).resolves.toMatchObject({
      userId: 'local-id',
      email: 'owner@example.com',
      username: 'Owner',
      authSubjectIds: ['cognito-sub', 'linked-sub'],
      authUsernamesBySubject: {
        'cognito-sub': 'native-owner',
        'linked-sub': 'Google_linked-owner',
      },
      householdId: 'household-1',
      householdRole: 'editor',
    });

    const transaction = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    const job = transaction.input.TransactItems?.find(
      (item) => item.Put?.Item?.entityType === 'ACCOUNT_DELETION_JOB',
    )?.Put?.Item;
    expect(job).toMatchObject({
      pk: 'ACCOUNT_DELETION_JOB#local-id',
      gsi2pk: 'ACCOUNT_DELETION_JOBS',
      userId: 'local-id',
      email: 'owner@example.com',
      username: 'Owner',
      authSubjectIds: ['cognito-sub', 'linked-sub'],
      authUsernamesBySubject: {
        'cognito-sub': 'native-owner',
        'linked-sub': 'Google_linked-owner',
      },
      householdId: 'household-1',
      householdRole: 'editor',
      pantryDeletionToken: expect.any(String),
    });
    expect(
      Date.parse(job!.nextAttemptAt as string) -
        Date.parse(job!.startedAt as string),
    ).toBe(120_000);
    expect(job!.gsi2sk).toBe(
      `${job!.nextAttemptAt}#${job!.startedAt}#local-id`,
    );
    expect(
      transaction.input.TransactItems?.find((item) => item.Update)?.Update
        ?.UpdateExpression,
    ).toContain('deletionFenceExpiresAt');
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            Key: { pk: 'HOUSEHOLD_MEMBER_BY_USER#local-id' },
            ConditionExpression: expect.stringContaining('householdId'),
          }),
        }),
      ]),
    );
  });

  it('deletes the owned pantry tombstone atomically with the account job', async () => {
    const account = user();
    const pending = deletionJobItem();
    const send = jest.fn().mockImplementation(async (command) => {
      if (!(command instanceof GetCommand)) return {};
      if (command.input.Key?.pk === 'ACCOUNT_DELETION_JOB#local-id') {
        return { Item: pending };
      }
      if (command.input.Key?.pk === 'USER#local-id') {
        return {
          Item: {
            ...account.toPrimitives(),
            pk: 'USER#local-id',
            entityType: 'USER',
            createdAt: account.createdAt.toISOString(),
            updatedAt: account.updatedAt.toISOString(),
          },
        };
      }
      return {};
    });

    await createDao(send).delete(account.id);

    const transaction = send.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Delete: expect.objectContaining({
            Key: { pk: 'PANTRY_QUOTA#local-id' },
            ConditionExpression: expect.stringContaining('deletionToken'),
            ExpressionAttributeValues: expect.objectContaining({
              ':deletionToken': 'pantry-delete-token',
            }),
          }),
        }),
        expect.objectContaining({
          Delete: expect.objectContaining({
            Key: { pk: 'ACCOUNT_DELETION_JOB#local-id' },
          }),
        }),
      ]),
    );
  });

  it('claims one eligible job atomically and defers it with backoff', async () => {
    const pending = deletionJobItem();
    const send = jest.fn(async (command) => {
      if (command instanceof QueryCommand) return { Items: [pending] };
      if (command instanceof UpdateCommand) {
        if (command.input.UpdateExpression?.includes('leaseToken')) {
          return {
            Attributes: {
              ...pending,
              leaseToken:
                command.input.ExpressionAttributeValues?.[':leaseToken'],
              leaseExpiresAt:
                command.input.ExpressionAttributeValues?.[':leaseExpiresAt'],
            },
          };
        }
        return {};
      }
      return {};
    });
    const dao = createDao(send);
    const now = new Date('2026-09-26T12:00:00.000Z');

    const claimed = await dao.claimPendingAccountDeletion(
      now,
      new Date('2026-09-26T12:02:00.000Z'),
    );
    expect(claimed).toMatchObject({
      userId: 'local-id',
      authUsernamesBySubject: {
        'cognito-sub': 'native-owner',
      },
      attempts: 0,
      leaseToken: expect.any(String),
    });
    const claim = send.mock.calls.find(
      ([command]) =>
        command instanceof UpdateCommand &&
        command.input.UpdateExpression?.includes('leaseToken'),
    )?.[0] as UpdateCommand;
    expect(claim.input.ConditionExpression).toContain('nextAttemptAt <= :now');
    expect(claim.input.UpdateExpression).toContain(
      'nextAttemptAt = :leaseExpiresAt',
    );
    expect(claim.input.UpdateExpression).toContain('gsi2sk = :gsi2sk');
    expect(claim.input.ExpressionAttributeValues?.[':gsi2sk']).toBe(
      '2026-09-26T12:02:00.000Z#2026-09-26T00:00:00.000Z#local-id',
    );

    await dao.deferAccountDeletion(
      claimed!,
      new Date('2026-09-26T12:04:00.000Z'),
    );
    const defer = send.mock.calls.at(-1)?.[0] as UpdateCommand;
    expect(defer.input.ConditionExpression).toBe('leaseToken = :leaseToken');
    expect(defer.input.UpdateExpression).toContain('REMOVE leaseToken');
  });

  it('hydrates a legacy deletion job without username references', async () => {
    const legacy = deletionJobItem();
    Reflect.deleteProperty(legacy, 'authUsernamesBySubject');
    const send = jest.fn().mockResolvedValue({ Items: [legacy] });

    await expect(
      createDao(send).findPendingAccountDeletions(1),
    ).resolves.toEqual([
      expect.objectContaining({ authUsernamesBySubject: {} }),
    ]);
  });

  it('continues past a page of leased jobs to claim later eligible work', async () => {
    const leased = Array.from({ length: 10 }, (_, index) => ({
      ...deletionJobItem(),
      pk: `ACCOUNT_DELETION_JOB#leased-${index}`,
      userId: `leased-${index}`,
    }));
    const eligible = {
      ...deletionJobItem(),
      pk: 'ACCOUNT_DELETION_JOB#eligible',
      userId: 'eligible',
    };
    let queryCount = 0;
    const send = jest.fn(async (command) => {
      if (command instanceof QueryCommand) {
        queryCount += 1;
        return queryCount === 1
          ? { Items: leased, LastEvaluatedKey: { cursor: 'page-2' } }
          : { Items: [eligible] };
      }
      if (command instanceof UpdateCommand) {
        if (command.input.Key?.pk !== eligible.pk) {
          const error = new Error('leased');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
        return {
          Attributes: {
            ...eligible,
            leaseToken:
              command.input.ExpressionAttributeValues?.[':leaseToken'],
            leaseExpiresAt:
              command.input.ExpressionAttributeValues?.[':leaseExpiresAt'],
          },
        };
      }
      return {};
    });
    const dao = createDao(send);

    await expect(
      dao.claimPendingAccountDeletion(
        new Date('2026-09-26T12:00:00.000Z'),
        new Date('2026-09-26T12:02:00.000Z'),
      ),
    ).resolves.toMatchObject({ userId: 'eligible' });
    const queries = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[1].input.ExclusiveStartKey).toEqual({ cursor: 'page-2' });
  });
});

function createDao(send: jest.Mock) {
  return new DynamoDbUserDao(
    { send } as unknown as DynamoDbDocumentClientService,
    new ConfigService({ DYNAMODB_USERS_TABLE: 'users' }),
  );
}

function user() {
  return User.fromPrimitives({
    id: 'local-id',
    email: 'owner@example.com',
    username: 'Owner',
    authSubjectIds: ['cognito-sub', 'linked-sub'],
    authUsernamesBySubject: {
      'cognito-sub': 'native-owner',
      'linked-sub': 'Google_linked-owner',
    },
    status: UserAccountStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function deletionJobItem() {
  return {
    pk: 'ACCOUNT_DELETION_JOB#local-id',
    entityType: 'ACCOUNT_DELETION_JOB',
    gsi2pk: 'ACCOUNT_DELETION_JOBS',
    gsi2sk: '2026-09-26T00:00:00.000Z#local-id',
    userId: 'local-id',
    email: 'owner@example.com',
    username: 'Owner',
    authSubjectIds: ['cognito-sub'],
    authUsernamesBySubject: { 'cognito-sub': 'native-owner' },
    startedAt: '2026-09-26T00:00:00.000Z',
    nextAttemptAt: '2026-09-26T00:00:00.000Z',
    attempts: 0,
    pantryDeletionToken: 'pantry-delete-token',
  };
}
