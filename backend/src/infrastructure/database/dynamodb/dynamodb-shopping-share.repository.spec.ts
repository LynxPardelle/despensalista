import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { hashShoppingShareToken } from '../../../application/utils/shopping-share-token';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbShoppingShareRepository } from './dynamodb-shopping-share.repository';

describe('DynamoDbShoppingShareRepository', () => {
  it('lists active owner shares sorted newest first', async () => {
    const older = makeItem({
      id: 'share-old',
      createdAt: new Date('2026-05-19T00:00:00.000Z'),
    });
    const newer = makeItem({
      id: 'share-new',
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
    });
    const dynamoDb = {
      send: jest.fn(async (command: QueryCommand) => {
        expect(command.input.IndexName).toBe('gsi2');
        expect(command.input.KeyConditionExpression).toContain('gsi2pk');
        return { Items: [older, newer] };
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbShoppingShareRepository(
      dynamoDb,
      makeConfigService(),
    );

    const shares = await repository.listActiveByOwnerUserId(
      'user-1',
      new Date('2026-05-19T12:00:00.000Z'),
    );

    expect(shares.map((share) => share.toPrimitives().id)).toEqual([
      'share-new',
      'share-old',
    ]);
  });

  it('does not scan the shared table when an indexed share id is missing', async () => {
    const dynamoDb = {
      send: jest.fn(async (command: QueryCommand | ScanCommand) => {
        if (command instanceof ScanCommand) {
          throw new Error('request-time table scans are forbidden');
        }

        return { Items: [] };
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbShoppingShareRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(repository.findById('missing')).resolves.toBeNull();
    expect(dynamoDb.send).toHaveBeenCalledTimes(1);
  });

  it('returns an empty indexed active-share list without scanning', async () => {
    const dynamoDb = {
      send: jest.fn(async (command: QueryCommand | ScanCommand) => {
        if (command instanceof ScanCommand) {
          throw new Error('request-time table scans are forbidden');
        }

        return { Items: [] };
      }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbShoppingShareRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(
      repository.listActiveByOwnerUserId('user-1', new Date()),
    ).resolves.toEqual([]);
    expect(dynamoDb.send).toHaveBeenCalledTimes(1);
  });

  it('deletes indexed owner shares without scanning the shared table', async () => {
    const indexed = makeItem({
      id: 'share-indexed',
      tokenHash: 'indexed-token-hash',
    });
    const deletedKeys: unknown[] = [];
    const dynamoDb = {
      send: jest.fn(
        async (command: QueryCommand | ScanCommand | DeleteCommand) => {
          if (command instanceof QueryCommand) {
            return { Items: [indexed] };
          }

          if (command instanceof ScanCommand) {
            throw new Error('request-time table scans are forbidden');
          }

          deletedKeys.push(command.input.Key);
          return {};
        },
      ),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbShoppingShareRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(
      repository.deleteByOwnerUserId(UserId.fromString('user-1')),
    ).resolves.toBe(1);

    expect(deletedKeys).toEqual([{ pk: 'SHOPPING_SHARE#indexed-token-hash' }]);
  });
});

function makeConfigService(): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue('users'),
  } as unknown as ConfigService;
}

function makeShare(): ShoppingShare {
  return ShoppingShare.fromPrimitives({
    id: 'share-1',
    ownerUserId: 'user-1',
    tokenHash: hashShoppingShareToken('server-backed-token'),
    text: 'Lista de compras',
    createdAt: new Date('2026-05-19T00:00:00.000Z'),
    expiresAt: new Date('2026-05-26T00:00:00.000Z'),
    updatedAt: new Date('2026-05-19T00:00:00.000Z'),
  });
}

function makeItem(
  overrides: Partial<ReturnType<ShoppingShare['toPrimitives']>>,
) {
  const primitives = {
    ...makeShare().toPrimitives(),
    ...overrides,
  };

  return {
    pk: `SHOPPING_SHARE#${primitives.tokenHash}`,
    entityType: 'SHOPPING_SHARE',
    id: primitives.id,
    ownerUserId: primitives.ownerUserId,
    tokenHash: primitives.tokenHash,
    text: primitives.text,
    createdAt: primitives.createdAt.toISOString(),
    expiresAt: primitives.expiresAt.toISOString(),
    updatedAt: primitives.updatedAt.toISOString(),
    expiresAtEpochSeconds: Math.floor(
      new Date(primitives.expiresAt).getTime() / 1000,
    ),
  };
}
