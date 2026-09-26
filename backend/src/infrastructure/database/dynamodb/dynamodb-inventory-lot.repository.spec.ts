import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { QuantityUnit } from '../../../domain/enums';
import { ProductTypeId } from '../../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbInventoryLotRepository } from './dynamodb-inventory-lot.repository';

describe('DynamoDbInventoryLotRepository', () => {
  it('deletes inventory lots across all DynamoDB result pages', async () => {
    const firstItem = buildInventoryLotItem('lot-1');
    const secondItem = buildInventoryLotItem('lot-2');
    const dynamoDb = {
      send: jest
        .fn()
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.ExclusiveStartKey).toBeUndefined();

          return {
            Items: [firstItem],
            LastEvaluatedKey: { id: firstItem.id },
          };
        })
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.ExclusiveStartKey).toEqual({ id: firstItem.id });

          return { Items: [secondItem] };
        })
        .mockResolvedValue({}),
    } as unknown as DynamoDbDocumentClientService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('inventory-lots'),
      get: jest.fn(),
    } as unknown as ConfigService;
    const repository = new DynamoDbInventoryLotRepository(
      dynamoDb,
      configService,
    );

    const deletedCount = await repository.deleteByUserId(
      UserId.fromString('user-1'),
    );

    expect(deletedCount).toBe(2);
    const deleteInputs = (dynamoDb.send as jest.Mock).mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteCommand)
      .map((command: DeleteCommand) => command.input);
    expect(deleteInputs).toEqual([
      expect.objectContaining({ Key: { id: 'lot-1' } }),
      expect.objectContaining({ Key: { id: 'lot-2' } }),
    ]);
  });

  it('pages archived inventory lots without dropping filtered DynamoDB results', async () => {
    const firstItem = {
      ...buildInventoryLotItem('lot-1'),
      archivedAt: '2026-05-20T00:00:00.000Z',
    };
    const secondItem = {
      ...buildInventoryLotItem('lot-2'),
      archivedAt: '2026-05-19T00:00:00.000Z',
    };
    const dynamoDb = {
      send: jest
        .fn()
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.Limit).toBe(2);

          return {
            Items: [firstItem],
            LastEvaluatedKey: { id: firstItem.id },
          };
        })
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.Limit).toBe(1);
          expect(command.input.ExclusiveStartKey).toEqual({ id: firstItem.id });

          return {
            Items: [secondItem],
            LastEvaluatedKey: { id: secondItem.id },
          };
        }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbInventoryLotRepository(
      dynamoDb,
      makeConfigService('inventory-lots'),
    );

    const page = await repository.findArchivedPageByUserId(
      UserId.fromString('user-1'),
      { limit: 2 },
    );

    expect(page.items.map((item) => item.id.toString())).toEqual([
      'lot-1',
      'lot-2',
    ]);
    expect(page.nextCursor).toBeDefined();
  });

  it('rejects invalid archived inventory lot cursors before querying DynamoDB', async () => {
    const dynamoDb = {
      send: jest.fn(),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbInventoryLotRepository(
      dynamoDb,
      makeConfigService('inventory-lots'),
    );

    await expect(
      repository.findArchivedPageByUserId(UserId.fromString('user-1'), {
        limit: 2,
        cursor: 'bad-cursor',
      }),
    ).rejects.toThrow('Invalid archived inventory lot cursor');
    expect(dynamoDb.send).not.toHaveBeenCalled();
  });

  it('strongly scans every page before deleting all lots for a product type', async () => {
    const firstItem = buildInventoryLotItem('lot-1');
    const secondItem = buildInventoryLotItem('lot-2');
    const unrelated = {
      ...buildInventoryLotItem('keep'),
      productTypeId: 'other-type',
    };
    const dynamoDb = {
      send: jest
        .fn()
        .mockImplementationOnce(async (command: ScanCommand) => {
          expect(command).toBeInstanceOf(ScanCommand);
          expect(command.input.ConsistentRead).toBe(true);
          expect(command.input.IndexName).toBeUndefined();
          return {
            Items: [firstItem, unrelated],
            LastEvaluatedKey: { id: firstItem.id },
          };
        })
        .mockImplementationOnce(async (command: ScanCommand) => {
          expect(command).toBeInstanceOf(ScanCommand);
          expect(command.input.ConsistentRead).toBe(true);
          expect(command.input.ExclusiveStartKey).toEqual({ id: 'lot-1' });
          return { Items: [secondItem] };
        })
        .mockResolvedValue({}),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbInventoryLotRepository(
      dynamoDb,
      makeConfigService('inventory-lots'),
    );

    await repository.deleteByProductTypeId(ProductTypeId.fromString('type-1'));

    const deletes = (dynamoDb.send as jest.Mock).mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteCommand)
      .map((command: DeleteCommand) => command.input.Key);
    expect(deletes).toEqual([{ id: 'lot-1' }, { id: 'lot-2' }]);
  });
});

function makeConfigService(tableName: string): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue(tableName),
    get: jest.fn(),
  } as unknown as ConfigService;
}

function buildInventoryLotItem(id: string) {
  return {
    entityType: 'INVENTORY_LOT',
    id,
    userId: 'user-1',
    productTypeId: 'type-1',
    variantName: 'Bolsa',
    quantity: 1,
    unit: QuantityUnit.PIECE,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };
}
