import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  Household,
  HouseholdActivity,
  HouseholdInvite,
  HouseholdMembership,
} from '../../../domain/entities/household.entity';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbHouseholdRepository } from './dynamodb-household.repository';

describe('DynamoDbHouseholdRepository', () => {
  it('claims one household per user and creates the owner atomically', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );
    const member = testMember();
    const household = Household.fromPrimitives({
      id: member.householdId,
      ownerUserId: member.userId,
      name: 'Test',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await repository.createHouseholdWithOwner(household, member);
    const transaction = send.mock.calls[0][0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            Key: { pk: 'USER#user-1' },
            ConditionExpression: expect.stringContaining(
              'deletionFenceExpiresAt',
            ),
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              pk: 'HOUSEHOLD_MEMBER_BY_USER#user-1',
            }),
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({ entityType: 'HOUSEHOLD' }),
          }),
        }),
      ]),
    );
  });

  it('accepts a live invite and claims membership in a single transaction', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );
    const now = new Date();
    const invite = HouseholdInvite.fromPrimitives({
      id: 'invite',
      householdId: 'household-1',
      invitedEmail: 'user@example.com',
      invitedByUserId: 'owner',
      role: 'editor',
      tokenHash: 'a'.repeat(64),
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60000),
    });
    invite.accept(now);
    await repository.acceptInvite(invite, testMember());
    const transaction = send.mock.calls[0][0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(
      transaction.input.TransactItems?.find(
        (item) => item.ConditionCheck?.Key?.pk === 'HOUSEHOLD#household-1',
      )?.ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            Key: { pk: 'USER#user-1' },
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            Key: { pk: 'USER#owner' },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({ entityType: 'HOUSEHOLD_INVITE' }),
            ConditionExpression: expect.stringContaining(
              'attribute_not_exists(revokedAt)',
            ),
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            Item: expect.objectContaining({
              pk: 'HOUSEHOLD_MEMBER_BY_USER#user-1',
            }),
          }),
        }),
      ]),
    );
  });

  it('checks every user referenced by an activity in the same transaction', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );

    await repository.saveActivity(
      HouseholdActivity.create({
        householdId: 'household-1',
        actorUserId: 'actor',
        targetUserId: 'target',
        type: 'member_removed',
      }),
    );

    const transaction = send.mock.calls[0][0] as TransactWriteCommand;
    const checkedKeys = transaction.input.TransactItems?.flatMap((item) =>
      item.ConditionCheck?.Key ? [item.ConditionCheck.Key] : [],
    );
    expect(checkedKeys).toEqual(
      expect.arrayContaining([{ pk: 'USER#actor' }, { pk: 'USER#target' }]),
    );
  });

  it('checks a registered invitee and its email lookup in the invite transaction', async () => {
    const send = jest.fn(async (command) =>
      command instanceof GetCommand ? { Item: { userId: 'invited' } } : {},
    );
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );
    const now = new Date();

    await repository.saveInvite(
      HouseholdInvite.create({
        householdId: 'household-1',
        invitedEmail: 'invited@example.com',
        invitedByUserId: 'owner',
        role: 'viewer',
        tokenHash: 'b'.repeat(64),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    );

    const transaction = send.mock.calls[1][0] as TransactWriteCommand;
    const checkedKeys = transaction.input.TransactItems?.flatMap((item) =>
      item.ConditionCheck?.Key ? [item.ConditionCheck.Key] : [],
    );
    expect(checkedKeys).toEqual(
      expect.arrayContaining([
        { pk: 'USER#owner' },
        { pk: 'USER#invited' },
        { pk: 'EMAIL#invited@example.com' },
      ]),
    );
  });
  it('does not scan the shared table when indexed membership is missing', async () => {
    const dynamoDb = {
      send: jest.fn(async (command: QueryCommand | ScanCommand) => {
        if (command instanceof ScanCommand) {
          throw new Error('request-time table scans are forbidden');
        }

        return { Items: [] };
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbHouseholdRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(
      repository.findMembershipByUserId('user-1'),
    ).resolves.toBeNull();
    expect(dynamoDb.send).toHaveBeenCalledTimes(2);
  });

  it('returns empty active invites without scanning the shared table', async () => {
    const dynamoDb = {
      send: jest.fn(async (command: QueryCommand | ScanCommand) => {
        if (command instanceof ScanCommand) {
          throw new Error('request-time table scans are forbidden');
        }

        return { Items: [] };
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbHouseholdRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(
      repository.findActiveInvitesByHouseholdId('household-1', new Date()),
    ).resolves.toEqual([]);
    expect(dynamoDb.send).toHaveBeenCalledTimes(1);
  });

  it('strongly deletes household data without deleting a reused membership key', async () => {
    const indexed = {
      pk: 'HOUSEHOLD#household-1#MEMBER#user-1',
      entityType: 'HOUSEHOLD_MEMBERSHIP',
      householdId: 'household-1',
    };
    const deletedKeys: unknown[] = [];
    const dynamoDb = {
      send: jest.fn(
        async (
          command: QueryCommand | ScanCommand | DeleteCommand | UpdateCommand,
        ) => {
          if (command instanceof UpdateCommand) return {};
          if (command instanceof ScanCommand) {
            expect(command.input.ConsistentRead).toBe(true);
            return { Items: [indexed] };
          }
          if (!(command instanceof DeleteCommand))
            throw new Error('Unexpected command');
          deletedKeys.push(command.input.Key);
          if (command.input.Key?.pk === indexed.pk) {
            expect((command as DeleteCommand).input.ConditionExpression).toBe(
              'householdId = :household',
            );
            throw Object.assign(new Error('membership moved'), {
              name: 'ConditionalCheckFailedException',
            });
          }
          return {};
        },
      ),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbHouseholdRepository(
      dynamoDb,
      makeConfigService(),
    );

    await repository.deleteHouseholdCascade('household-1');

    expect(deletedKeys).toEqual([
      { pk: 'HOUSEHOLD#household-1#MEMBER#user-1' },
      { pk: 'HOUSEHOLD#household-1' },
    ]);
  });

  it('locks first, scans every membership page strongly, and reopens if another member exists', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: 'page-1' } })
      .mockResolvedValueOnce({
        Items: [{ userId: 'invited', householdId: 'household-1' }],
      })
      .mockResolvedValueOnce({});
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );
    await expect(
      repository.beginHouseholdDeletion('household-1', 'owner'),
    ).resolves.toBe(false);
    const close = send.mock.calls[0][0] as UpdateCommand;
    expect(close.input.ConditionExpression).toBe('ownerUserId = :owner');
    expect(close.input.UpdateExpression).toBe('SET deleting = :token');
    const firstPage = send.mock.calls[1][0] as ScanCommand;
    const secondPage = send.mock.calls[2][0] as ScanCommand;
    expect(firstPage).toBeInstanceOf(ScanCommand);
    expect(firstPage.input.ConsistentRead).toBe(true);
    expect(firstPage.input.IndexName).toBeUndefined();
    expect(secondPage.input.ConsistentRead).toBe(true);
    expect(secondPage.input.ExclusiveStartKey).toEqual({ pk: 'page-1' });
    const reopen = send.mock.calls[3][0] as UpdateCommand;
    expect(reopen.input.UpdateExpression).toBe('REMOVE deleting');
    expect(reopen.input.ConditionExpression).toBe('deleting = :token');
    expect(reopen.input.ExpressionAttributeValues?.[':token']).toBe(
      close.input.ExpressionAttributeValues?.[':token'],
    );
  });

  it('keeps the parent closed once no other members remain and supports a retry', async () => {
    const send = jest.fn(async (command) =>
      command instanceof ScanCommand ? { Items: [] } : {},
    );
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );
    await expect(
      repository.beginHouseholdDeletion('household-1', 'owner'),
    ).resolves.toBe(true);
    await expect(
      repository.beginHouseholdDeletion('household-1', 'owner'),
    ).resolves.toBe(true);
    expect(
      send.mock.calls.filter(([command]) => command instanceof UpdateCommand),
    ).toHaveLength(2);
    expect(
      send.mock.calls.some(
        ([command]) => command.input.UpdateExpression === 'REMOVE deleting',
      ),
    ).toBe(false);
  });

  it('resumes deletion when an older attempt already removed the parent', async () => {
    const send = jest.fn(async (command) => {
      if (command instanceof UpdateCommand) {
        throw Object.assign(new Error('parent missing'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      if (command instanceof GetCommand) return {};
      if (command instanceof ScanCommand) return { Items: [] };
      return {};
    });
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );

    await expect(
      repository.beginHouseholdDeletion('household-1', 'owner'),
    ).resolves.toBe(true);
  });

  it('anonymizes retained household history in paged transactional batches', async () => {
    const transactions: TransactWriteCommand[] = [];
    const deletes: DeleteCommand[] = [];
    const send = jest.fn(async (command) => {
      if (command instanceof ScanCommand) {
        expect(command.input.ConsistentRead).toBe(true);
        if (!command.input.ExclusiveStartKey) {
          return {
            Items: [
              {
                pk: 'HOUSEHOLD_ACTIVITY#a',
                entityType: 'HOUSEHOLD_ACTIVITY',
                householdId: 'household-1',
                actorUserId: 'user-1',
                targetUserId: 'other-user',
                targetLabel: 'Other user',
              },
              {
                pk: 'HOUSEHOLD_INVITE#i',
                entityType: 'HOUSEHOLD_INVITE',
                householdId: 'household-1',
                invitedByUserId: 'other-user',
                invitedEmail: 'USER@example.com',
              },
            ],
            LastEvaluatedKey: { pk: 'page-2' },
          };
        }
        return {
          Items: [
            {
              pk: 'HOUSEHOLD_ACTIVITY#b',
              entityType: 'HOUSEHOLD_ACTIVITY',
              householdId: 'household-1',
              actorUserId: 'other-user',
              targetUserId: 'user-1',
              targetLabel: 'Private label',
            },
          ],
        };
      }
      if (command instanceof TransactWriteCommand) {
        transactions.push(command);
        return {};
      }
      if (command instanceof DeleteCommand) {
        deletes.push(command);
        return {};
      }
      throw new Error('Unexpected command');
    });
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );

    await repository.deleteAccountHouseholdData(
      'household-1',
      'user-1',
      'user@example.com',
    );

    expect(transactions).toHaveLength(2);
    expect(JSON.stringify(transactions)).toContain('deleted-user');
    expect(JSON.stringify(transactions)).toContain('Usuario eliminado');
    expect(deletes[0]?.input.Key).toEqual({
      pk: 'HOUSEHOLD_MEMBER_BY_USER#user-1',
    });
  });

  it('checks that the household is open before every membership write', async () => {
    const send = jest.fn().mockResolvedValue({});
    const repository = new DynamoDbHouseholdRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      makeConfigService(),
    );
    await repository.saveMembership(testMember());
    const transaction = send.mock.calls[0][0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(
      transaction.input.TransactItems?.find(
        (item) => item.ConditionCheck?.Key?.pk === 'HOUSEHOLD#household-1',
      )?.ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');
  });
});

function makeConfigService(): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue('users'),
  } as unknown as ConfigService;
}

function testMember(): HouseholdMembership {
  return HouseholdMembership.fromPrimitives({
    householdId: 'household-1',
    userId: 'user-1',
    email: 'user@example.com',
    username: 'User',
    role: 'editor',
    joinedAt: new Date(),
    updatedAt: new Date(),
  });
}
