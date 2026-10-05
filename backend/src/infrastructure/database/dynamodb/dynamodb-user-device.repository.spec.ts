import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { UserDevice } from '../../../domain/entities/user-device.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbUserDeviceRepository } from './dynamodb-user-device.repository';

describe('DynamoDbUserDeviceRepository account fence', () => {
  it('atomically reserves capacity before creating a new device', async () => {
    const dynamo = {
      send: jest
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          Item: {
            pk: 'USER_DEVICE_RESERVATION#user-1',
            entityType: 'USER_DEVICE_RESERVATION',
            userId: 'user-1',
            count: 24,
          },
        })
        .mockResolvedValueOnce({}),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await repository.save(makeDevice());

    expect((dynamo.send as jest.Mock).mock.calls[0][0]).toBeInstanceOf(
      GetCommand,
    );
    const command = (dynamo.send as jest.Mock).mock
      .calls[2][0] as TransactWriteCommand;
    expect(command.input.TransactItems).toHaveLength(3);
    expect(command.input.TransactItems?.[0].ConditionCheck).toMatchObject({
      Key: { pk: 'USER#user-1' },
      ConditionExpression: expect.stringContaining('deletionFenceExpiresAt'),
    });
    expect(command.input.TransactItems?.[1].Update).toMatchObject({
      Key: { pk: 'USER_DEVICE_RESERVATION#user-1' },
      UpdateExpression: 'ADD #count :one',
      ConditionExpression: '#count < :limit',
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': 25,
      },
    });
    expect(command.input.TransactItems?.[2].Put).toMatchObject({
      Item: { entityType: 'USER_DEVICE', userId: 'user-1' },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('updates an existing device without consuming another slot', async () => {
    const dynamo = {
      send: jest.fn(async (command: unknown) =>
        command instanceof GetCommand ? { Item: deviceItem('device-1') } : {},
      ),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await repository.save(makeDevice());

    const command = (dynamo.send as jest.Mock).mock
      .calls[1][0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(2);
    expect(command.input.TransactItems?.[0].ConditionCheck).toMatchObject({
      Key: { pk: 'USER#user-1' },
      ConditionExpression: expect.stringContaining('deletionFenceExpiresAt'),
    });
    expect(command.input.TransactItems?.[1].Put).toMatchObject({
      Item: { entityType: 'USER_DEVICE', userId: 'user-1' },
      ConditionExpression: expect.stringContaining('userId = :userId'),
    });
  });

  it('rejects a delayed device write once account deletion wins the transaction', async () => {
    const dynamo = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetCommand) {
          return { Item: deviceItem('device-1') };
        }
        throw transactionCanceled();
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await expect(repository.save(makeDevice())).rejects.toThrow(
      'deletion is in progress',
    );
  });

  it('initializes a missing reservation from legacy devices before admitting another', async () => {
    let getCalls = 0;
    let transactionCalls = 0;
    const dynamo = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetCommand) {
          getCalls += 1;
          return getCalls <= 2 ? {} : { Item: undefined };
        }
        if (command instanceof ScanCommand) {
          return { Items: [deviceItem('legacy-device')] };
        }
        if (command instanceof TransactWriteCommand) {
          transactionCalls += 1;
          return {};
        }
        return {};
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await repository.save(makeDevice());

    const transactions = (dynamo.send as jest.Mock).mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is TransactWriteCommand =>
          command instanceof TransactWriteCommand,
      );
    expect(transactionCalls).toBe(2);
    expect(transactions[0].input.TransactItems?.[1].Put).toMatchObject({
      Item: {
        pk: 'USER_DEVICE_RESERVATION#user-1',
        entityType: 'USER_DEVICE_RESERVATION',
        count: 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('treats a duplicate create race as an idempotent existing device', async () => {
    let getCalls = 0;
    const dynamo = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetCommand) {
          getCalls += 1;
          if (getCalls === 1) return {};
          if (getCalls === 2) return { Item: reservationItem(24) };
          return { Item: deviceItem('device-1') };
        }
        throw transactionCanceled();
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await expect(repository.save(makeDevice())).resolves.toMatchObject({
      id: 'device-1',
    });
  });

  it('returns no device when a distinct create loses the final slot', async () => {
    let getCalls = 0;
    const dynamo = {
      send: jest.fn(async (command: unknown) => {
        if (command instanceof GetCommand) {
          getCalls += 1;
          if (getCalls === 2) return { Item: reservationItem(24) };
          if (getCalls === 4) return { Item: reservationItem(25) };
          return {};
        }
        throw transactionCanceled();
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await expect(repository.save(makeDevice())).resolves.toBeNull();
  });

  it('strongly scans every page before deleting account devices', async () => {
    const first = deviceItem('device-1');
    const second = deviceItem('device-2');
    const dynamo = {
      send: jest
        .fn()
        .mockImplementationOnce(async (command: ScanCommand) => {
          expect(command).toBeInstanceOf(ScanCommand);
          expect(command.input.ConsistentRead).toBe(true);
          expect(command.input.IndexName).toBeUndefined();
          return {
            Items: [first],
            LastEvaluatedKey: { pk: first.pk },
          };
        })
        .mockImplementationOnce(async (command: ScanCommand) => {
          expect(command.input.ExclusiveStartKey).toEqual({ pk: first.pk });
          return { Items: [second] };
        })
        .mockResolvedValue({}),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await expect(
      repository.deleteByUserId(UserId.fromString('user-1')),
    ).resolves.toBe(2);

    const keys = (dynamo.send as jest.Mock).mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteCommand)
      .map((command: DeleteCommand) => command.input.Key);
    expect(keys).toEqual([
      { pk: 'USER_DEVICE#device-1' },
      { pk: 'USER_DEVICE#device-2' },
      { pk: 'USER_DEVICE_RESERVATION#user-1' },
    ]);
  });
});

function makeConfig(): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue('users'),
  } as unknown as ConfigService;
}

function makeDevice(): UserDevice {
  return UserDevice.create({
    id: 'device-1',
    userId: UserId.fromString('user-1'),
    label: 'Chrome en Windows',
    userAgentSummary: 'Chrome en Windows',
    now: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function deviceItem(id: string) {
  return {
    pk: `USER_DEVICE#${id}`,
    entityType: 'USER_DEVICE',
    gsi1pk: 'USER_DEVICE#user-1',
    gsi1sk: '2026-09-01T00:00:00.000Z',
    id,
    userId: 'user-1',
    label: 'Chrome en Windows',
    userAgentSummary: 'Chrome en Windows',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    seenCount: 1,
  };
}

function reservationItem(count: number) {
  return {
    pk: 'USER_DEVICE_RESERVATION#user-1',
    entityType: 'USER_DEVICE_RESERVATION',
    userId: 'user-1',
    count,
  };
}

function transactionCanceled(): Error {
  return Object.assign(new Error('conditional transaction failed'), {
    name: 'TransactionCanceledException',
  });
}
