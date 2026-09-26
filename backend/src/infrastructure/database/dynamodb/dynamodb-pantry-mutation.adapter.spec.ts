import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  TransactWriteCommand,
  DeleteCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { WasteEvent } from '../../../domain/entities/waste-event.entity';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { IdempotencyPayloadConflictError } from '../../../application/ports/pantry-mutation.port';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';
import { Product } from '../../../domain/entities/product.entity';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { ProductStatus } from '../../../domain/enums';
import { Period } from '../../../domain/enums/period.enum';
import { hashShoppingShareToken } from '../../../application/utils/shopping-share-token';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbPantryMutationAdapter } from './dynamodb-pantry-mutation.adapter';

describe('DynamoDbPantryMutationAdapter', () => {
  it('retains a minimal expiring deletion lock and rejects a delayed writer', async () => {
    const until = new Date(Date.now() + 86400_000);
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) return { $metadata: {}, Items: [] };
      if (command instanceof GetCommand)
        return {
          $metadata: {},
          Item: {
            pk: 'PANTRY_QUOTA#user-1',
            ownerUserId: 'user-1',
            deleting: true,
          },
        };
      if (command instanceof TransactWriteCommand)
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [
            { Code: 'None' },
            { Code: 'ConditionalCheckFailed' },
          ],
        });
      return { $metadata: {} };
    });
    const adapter = makeAdapter(dynamo);
    await adapter.beginPantryDeletion('user-1', until);
    const begin = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(begin.input.ExpressionAttributeValues).toMatchObject({
      ':expiresAtEpochSeconds': Math.floor(until.getTime() / 1000),
    });
    await adapter.completePantryDeletion('user-1', until);
    const marker = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutCommand) as PutCommand;
    expect(marker?.input.Item).toEqual({
      pk: 'PANTRY_QUOTA#user-1',
      entityType: 'PANTRY_QUOTA',
      ownerUserId: 'user-1',
      deleting: true,
      expiresAt: until.toISOString(),
      expiresAtEpochSeconds: Math.floor(until.getTime() / 1000),
    });
    await expect(
      adapter.createProductType(makeProductType('late')),
    ).rejects.toThrow();
    const attempted = dynamo.send.mock.calls
      .map(([command]) => command)
      .find(
        (command) => command instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
    expect(
      attempted.input.TransactItems?.[1].Update?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');
    await adapter.completePantryDeletion('user-1');
    const release = dynamo.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteCommand)
      .at(-1) as DeleteCommand;
    expect(release.input.ConditionExpression).toBe(
      'attribute_not_exists(expiresAtEpochSeconds)',
    );
  });

  it.each([0, -1, Number.NaN])(
    'rejects retained expired or invalid receipts without replay (%s)',
    async (remainingMs) => {
      const dynamo = makeDynamo();
      const expiresAt = Number.isNaN(remainingMs)
        ? 'invalid-date'
        : new Date(Date.now() + remainingMs).toISOString();
      dynamo.send.mockResolvedValueOnce({
        $metadata: {},
        Item: {
          ...receipt('consume_inventory_lot'),
          response: null,
          expiresAt,
        },
      });

      await expect(
        makeAdapter(dynamo).findReceipt(receipt('consume_inventory_lot')),
      ).rejects.toThrow('Idempotency-Key has expired');
      expect(dynamo.send).toHaveBeenCalledTimes(1);
      expect(dynamo.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    },
  );

  it('returns a matching receipt within the seven-day replay window', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockResolvedValueOnce({
      $metadata: {},
      Item: {
        ...receipt('consume_inventory_lot'),
        response: null,
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      },
    });
    await expect(
      makeAdapter(dynamo).findReceipt(receipt('consume_inventory_lot')),
    ).resolves.toMatchObject({ response: null, requestHash: 'request-hash' });
  });

  it('writes receipt, waste, lot deletion and quota decrement atomically', async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: quotaItem() });
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const adapter = makeAdapter(dynamo);
    const lot = makeLot(1);

    const result = await adapter.consume({
      receipt: receipt('consume_inventory_lot'),
      expectedLot: lot,
      updatedLot: null,
      wasteEvent: WasteEvent.create({
        userId: lot.userId,
        productTypeId: lot.productTypeId,
        inventoryLotId: lot.id,
        productName: 'Arroz',
        quantity: 1,
        unit: lot.unit,
        reason: 'expired',
      }),
    });

    expect(result).toEqual({ value: null, replayed: false });
    expect(dynamo.send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const command = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    expect(command.input.TransactItems).toHaveLength(5);
    expect(command.input.TransactItems?.[0].Put?.Item).toMatchObject({
      entityType: 'PANTRY_OPERATION',
      requestHash: 'request-hash',
      expiresAtEpochSeconds: 1788825600,
    });
    expect(
      command.input.TransactItems?.[1].Delete?.ConditionExpression,
    ).toContain('updatedAt = :expectedUpdatedAt');
    expect(
      command.input.TransactItems?.[3].Update?.ConditionExpression,
    ).toContain('activeInventoryLots >= :delta');
    expect(
      command.input.TransactItems?.[4].ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');
  });

  it('uses exactly 100 actions for a worst-case checkout of 49 distinct types', async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: quotaItem() });
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const adapter = makeAdapter(dynamo);
    const productTypes = Array.from({ length: 49 }, (_, index) =>
      makeProductType(`type-${index}`),
    );
    const lots = productTypes.map((type, index) =>
      makeLot(1, `lot-${index}`, type.id.toString()),
    );

    await adapter.checkout({
      receipt: receipt('close_shopping_purchase'),
      lots,
      productTypes: productTypes.map((type) => ({
        expected: ProductType.fromPrimitives(type.toPrimitives()),
        updated: type,
        changed: false,
      })),
    });

    const command = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    expect(command.input.TransactItems).toHaveLength(100);
    expect(command.input.ClientRequestToken).toHaveLength(36);
    expect(
      command.input.TransactItems?.at(-1)?.Update?.ConditionExpression,
    ).toContain('activeInventoryLots <= :remainingTotal');
  });

  it('strongly sweeps all owner tables before deleting the quota lock', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) {
        expect(command.input.ConsistentRead).toBe(true);
        if (command.input.TableName === 'users')
          return {
            $metadata: {},
            Items: [
              {
                pk: 'PANTRY_OPERATION#receipt',
                entityType: 'PANTRY_OPERATION',
              },
              { pk: 'USER#keep', entityType: 'USER' },
            ],
          };
        return {
          $metadata: {},
          Items: [{ id: `${command.input.TableName}-remaining` }],
        };
      }
      return { $metadata: {} };
    });
    await makeAdapter(dynamo).completePantryDeletion('user-1');
    const deletes = dynamo.send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is DeleteCommand => command instanceof DeleteCommand,
      )
      .map((command) => command.input);
    expect(deletes.map((input) => input.Key)).toEqual([
      { id: 'lots-remaining' },
      { id: 'types-remaining' },
      { id: 'products-remaining' },
      { pk: 'PANTRY_OPERATION#receipt' },
      { pk: 'PANTRY_QUOTA#user-1' },
    ]);
  });

  it('preserves configured archive retention when mutations use transactions', async () => {
    const dynamo = makeDynamo();
    dynamo.send
      .mockResolvedValueOnce({ Item: quotaItem(), $metadata: {} })
      .mockResolvedValueOnce({ $metadata: {} });
    const config = new ConfigService({
      DYNAMODB_USERS_TABLE: 'users',
      DYNAMODB_PRODUCT_TYPES_TABLE: 'types',
      DYNAMODB_INVENTORY_LOTS_TABLE: 'lots',
      DYNAMODB_PRODUCTS_TABLE: 'products',
      ARCHIVED_RECORD_AUTO_DELETE_ENABLED: 'true',
      ARCHIVED_RECORD_RETENTION_DAYS: 30,
    });
    const adapter = new DynamoDbPantryMutationAdapter(dynamo, config);
    const lot = makeLot(1);
    const expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive();
    await adapter.archiveInventoryLot(expected, lot);
    const command = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    expect(
      command.input.TransactItems?.[0].Put?.Item?.expiresAtEpochSeconds,
    ).toBe(Math.floor(lot.archivedAt!.getTime() / 1000) + 30 * 86400);
  });

  it('rejects an existing receipt when the payload hash differs', async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({
      Item: {
        pk: 'PANTRY_OPERATION#operation-1',
        entityType: 'PANTRY_OPERATION',
        operationId: 'operation-1',
        ownerUserId: 'user-1',
        operation: 'consume_inventory_lot',
        requestHash: 'another-hash',
        response: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-09-08T00:00:00.000Z',
        expiresAtEpochSeconds: 1788220800,
      },
    });
    const adapter = makeAdapter(dynamo);

    await expect(
      adapter.findReceipt(receipt('consume_inventory_lot')),
    ).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });

  it('creates a lot only while owner and product-type quotas have capacity', async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock).mockResolvedValueOnce({ Item: quotaItem() });
    (dynamo.send as jest.Mock).mockResolvedValueOnce({});
    const adapter = makeAdapter(dynamo);

    await adapter.createInventoryLot(makeLot(1));

    const command = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    expect(command.input.TransactItems).toHaveLength(3);
    expect(
      command.input.TransactItems?.[2].ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(archivedAt)');
    expect(
      command.input.TransactItems?.[1].Update?.ConditionExpression,
    ).toContain('activeInventoryLots <= :remainingTotal');
    expect(
      command.input.TransactItems?.[1].Update?.ConditionExpression,
    ).toContain('lotsByProductType.#productType <= :remainingType');
  });

  it('creates product types and saved lists with atomic owner quota checks', async () => {
    const dynamo = makeDynamo();
    (dynamo.send as jest.Mock)
      .mockResolvedValueOnce({ Item: quotaItem() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: quotaItem() })
      .mockResolvedValueOnce({});
    const adapter = makeAdapter(dynamo);

    await adapter.createProductType(makeProductType('type-new'));
    await adapter.createShoppingList(
      ShoppingList.create({
        ownerUserId: 'user-1',
        title: 'Semanal',
        items: [
          {
            productTypeId: 'type-1',
            baseName: 'Leche',
            quantity: 1,
            unit: QuantityUnit.PIECE,
          },
        ],
      }),
    );

    const typeCommand = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    const listCommand = dynamo.send.mock.calls[3][0] as TransactWriteCommand;
    expect(typeCommand.input.TransactItems?.[1].Update).toMatchObject({
      ConditionExpression:
        'activeProductTypes < :maximum AND attribute_not_exists(productTypeNames.#name) AND attribute_not_exists(deleting)',
    });
    expect(listCommand.input.TransactItems?.[1].Update).toMatchObject({
      ConditionExpression:
        '#counter < :maximum AND attribute_not_exists(deleting)',
      ExpressionAttributeNames: { '#counter': 'savedShoppingLists' },
    });
  });

  it('atomically fences legacy products and public shares with optimistic writes', async () => {
    const dynamo = makeDynamo();
    dynamo.send
      .mockResolvedValueOnce({ Item: quotaItem(), $metadata: {} })
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce({ Item: quotaItem(), $metadata: {} })
      .mockResolvedValueOnce({ $metadata: {} });
    const adapter = makeAdapter(dynamo);
    const product = makeProduct();
    const expectedProduct = Product.fromPrimitives(product.toPrimitives());
    product.updateQuantity(1);
    const share = makeShare();
    const expectedShare = ShoppingShare.fromPrimitives(share.toPrimitives());
    share.revoke('user-1');

    await adapter.updateProduct(expectedProduct, product);
    await adapter.updateShoppingShare(expectedShare, share);

    const productWrite = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    const shareWrite = dynamo.send.mock.calls[3][0] as TransactWriteCommand;
    expect(productWrite.input.TransactItems).toHaveLength(2);
    expect(
      productWrite.input.TransactItems?.[0].Put?.ConditionExpression,
    ).toContain('updatedAt = :expectedUpdatedAt');
    expect(
      productWrite.input.TransactItems?.[1].ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');
    expect(shareWrite.input.TransactItems?.[0].Put?.Item).toMatchObject({
      entityType: 'SHOPPING_SHARE',
      expiresAtEpochSeconds: 1788825600,
    });
    expect(
      shareWrite.input.TransactItems?.[1].ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');
  });

  it('tombstones product types and prevents stale lot archives during cleanup', async () => {
    const dynamo = makeDynamo();
    dynamo.send
      .mockResolvedValueOnce({ Item: quotaItem(), $metadata: {} })
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce({ Item: quotaItem(), $metadata: {} })
      .mockResolvedValueOnce({ $metadata: {} })
      .mockResolvedValueOnce({ Item: quotaItem(), $metadata: {} })
      .mockResolvedValueOnce({ $metadata: {} });
    const adapter = makeAdapter(dynamo);
    const type = makeProductType('type-delete');
    type.archive();

    await adapter.beginProductTypeDeletion(type);
    const lot = makeLot(2, 'lot-stale', type.id.toString());
    const expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive();
    await adapter.archiveInventoryLot(expected, lot);

    const begin = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    expect(begin.input.TransactItems?.[0].Update).toMatchObject({
      UpdateExpression: 'SET deleting = :deleting REMOVE expiresAtEpochSeconds',
      ConditionExpression: expect.stringContaining(
        'attribute_exists(archivedAt)',
      ),
    });
    const archive = dynamo.send.mock.calls[3][0] as TransactWriteCommand;
    expect(
      archive.input.TransactItems?.at(-1)?.ConditionCheck?.ConditionExpression,
    ).toContain('attribute_not_exists(deleting)');

    await adapter.deleteProductType(type);
    const finish = dynamo.send.mock.calls[5][0] as TransactWriteCommand;
    expect(
      finish.input.TransactItems?.[0].Delete?.ConditionExpression,
    ).toContain('deleting = :deleting');
  });
});

function makeDynamo(): jest.Mocked<DynamoDbDocumentClientService> {
  return {
    send: jest.fn(),
  } as unknown as jest.Mocked<DynamoDbDocumentClientService>;
}

function makeAdapter(
  dynamo: jest.Mocked<DynamoDbDocumentClientService>,
): DynamoDbPantryMutationAdapter {
  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn(
      (key: string) =>
        ({
          DYNAMODB_USERS_TABLE: 'users',
          DYNAMODB_PRODUCT_TYPES_TABLE: 'types',
          DYNAMODB_INVENTORY_LOTS_TABLE: 'lots',
          DYNAMODB_PRODUCTS_TABLE: 'products',
        })[key],
    ),
  } as unknown as ConfigService;
  return new DynamoDbPantryMutationAdapter(dynamo, config);
}

function receipt(
  operation: 'consume_inventory_lot' | 'close_shopping_purchase',
) {
  return {
    operationId:
      'pantry_operation_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ownerUserId: 'user-1',
    operation,
    requestHash: 'request-hash',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2026-09-08T00:00:00.000Z'),
  };
}

function quotaItem() {
  return {
    pk: 'PANTRY_QUOTA#user-1',
    entityType: 'PANTRY_QUOTA',
    ownerUserId: 'user-1',
    activeProductTypes: 49,
    activeInventoryLots: 100,
    savedShoppingLists: 2,
    lotsByProductType: {},
    productTypeNames: {},
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function makeLot(
  quantity: number,
  id = 'lot-1',
  productTypeId = 'type-1',
): InventoryLot {
  return InventoryLot.fromPrimitives({
    id,
    userId: 'user-1',
    productTypeId,
    quantity,
    unit: QuantityUnit.PIECE,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function makeProductType(id: string): ProductType {
  return ProductType.create(
    UserId.fromString('user-1'),
    `Producto ${id}`,
    ProductCategory.FOOD,
    QuantityUnit.PIECE,
  );
}

function makeProduct(): Product {
  return Product.fromPrimitives({
    id: 'product-1',
    userId: 'user-1',
    title: 'Arroz',
    currentQuantity: 2,
    unit: QuantityUnit.KILOGRAM,
    usageRate: { amount: 1, period: Period.WEEK },
    category: ProductCategory.FOOD,
    status: ProductStatus.AVAILABLE,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

function makeShare(): ShoppingShare {
  return ShoppingShare.fromPrimitives({
    id: 'share-1',
    ownerUserId: 'user-1',
    tokenHash: hashShoppingShareToken('opaque-token-1234'),
    text: 'Lista pública',
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    expiresAt: new Date('2026-09-08T00:00:00.000Z'),
  });
}
