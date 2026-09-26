import { ConfigService } from '@nestjs/config';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { User } from '../../../domain/entities/user.entity';
import { UserAccountStatus } from '../../../domain/enums';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbUserDao } from './dynamodb-user.dao';

describe('DynamoDbUserDao account revocation', () => {
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
    status: UserAccountStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
