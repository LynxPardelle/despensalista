import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { UserDevice } from '../../../domain/entities/user-device.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbUserDeviceRepository } from './dynamodb-user-device.repository';

describe('DynamoDbUserDeviceRepository account fence', () => {
  it('saves a device in one transaction with the active account fence', async () => {
    const dynamo = {
      send: jest.fn().mockResolvedValue({}),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await repository.save(makeDevice());

    const command = (dynamo.send as jest.Mock).mock
      .calls[0][0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems?.[0].ConditionCheck).toMatchObject({
      Key: { pk: 'USER#user-1' },
      ConditionExpression: expect.stringContaining('deletionFenceExpiresAt'),
    });
    expect(command.input.TransactItems?.[1].Put?.Item).toMatchObject({
      entityType: 'USER_DEVICE',
      userId: 'user-1',
    });
  });

  it('rejects a delayed device write once account deletion wins the transaction', async () => {
    const dynamo = {
      send: jest.fn().mockRejectedValue(
        Object.assign(new Error('fenced'), {
          name: 'TransactionCanceledException',
        }),
      ),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbUserDeviceRepository(dynamo, makeConfig());

    await expect(repository.save(makeDevice())).rejects.toThrow(
      'deletion is in progress',
    );
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
