import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  TransactWriteCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { WasteEvent } from '../../../domain/entities/waste-event.entity';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import {
  IdempotencyPayloadConflictError,
  PantryDeletionReceipt,
  PantryMutationConflictError,
} from '../../../application/ports/pantry-mutation.port';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';
import { Product } from '../../../domain/entities/product.entity';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { ProductStatus } from '../../../domain/enums';
import { Period } from '../../../domain/enums/period.enum';
import { hashShoppingShareToken } from '../../../application/utils/shopping-share-token';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbPantryMutationAdapter } from './dynamodb-pantry-mutation.adapter';

describe('DynamoDbPantryMutationAdapter', () => {
  it('uses an authoritative consistent sweep before releasing a deletion fence', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof QueryCommand) {
        return { $metadata: {}, Items: [] };
      }
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: quotaItem({
            deleting: true,
            deletionToken: 'delete-token',
            retainFence: false,
          }),
        };
      }
      if (command instanceof ScanCommand) {
        expect(command.input.ConsistentRead).toBe(true);
        return command.input.TableName === 'lots'
          ? {
              $metadata: {},
              Items: [
                {
                  id: 'authoritative-lot',
                  entityType: 'INVENTORY_LOT',
                  userId: 'user-1',
                },
              ],
            }
          : { $metadata: {}, Items: [] };
      }
      return { $metadata: {} };
    });

    await makeAdapter(dynamo).completePantryDeletion('user-1', 'delete-token');

    expect(
      dynamo.send.mock.calls.some(
        ([command]) =>
          command instanceof DeleteCommand &&
          command.input.TableName === 'lots' &&
          command.input.Key?.id === 'authoritative-lot',
      ),
    ).toBe(true);
  });

  it('binds a mutation to the quota epoch captured before a pantry reset', async () => {
    const dynamo = makeDynamo();
    dynamo.send
      .mockResolvedValueOnce({
        $metadata: {},
        Item: quotaItem({ mutationEpoch: 7 }),
      })
      .mockResolvedValueOnce({ $metadata: {} });

    await makeAdapter(dynamo).createInventoryLot(makeLot(1));

    const transaction = dynamo.send.mock.calls[1][0] as TransactWriteCommand;
    expect(transaction.input.TransactItems?.[1].Update).toMatchObject({
      ConditionExpression: expect.stringContaining(
        'mutationEpoch = :mutationEpoch',
      ),
      ExpressionAttributeValues: expect.objectContaining({
        ':mutationEpoch': 7,
        ':quotaSchemaVersion': 2,
        ':deleting': false,
      }),
    });
  });

  it('fences legacy writers before an authoritative versioned quota migration', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: {
            pk: 'PANTRY_QUOTA#user-1',
            entityType: 'PANTRY_QUOTA',
            ownerUserId: 'user-1',
            activeProductTypes: 0,
            activeInventoryLots: 0,
            savedShoppingLists: 0,
            lotsByProductType: {},
            productTypeNames: {},
          },
        };
      }
      if (command instanceof ScanCommand) {
        return { $metadata: {}, Items: [] };
      }
      return { $metadata: {} };
    });

    await makeAdapter(dynamo).createInventoryLot(makeLot(1));

    const commands = dynamo.send.mock.calls.map(([command]) => command);
    const fence = commands.find(
      (command) =>
        command instanceof UpdateCommand &&
        command.input.ExpressionAttributeValues?.[':deleting'] === true,
    ) as UpdateCommand;
    expect(fence.input.UpdateExpression).toContain('deleting = :deleting');
    const migrated = commands.find(
      (command) =>
        command instanceof PutCommand &&
        command.input.Item?.quotaSchemaVersion === 2,
    ) as PutCommand;
    expect(migrated.input.Item).toMatchObject({
      quotaSchemaVersion: 2,
      mutationEpoch: 0,
      deleting: false,
      archivedProductTypes: 0,
      archivedInventoryLots: 0,
    });
    expect(migrated.input.ConditionExpression).toContain('migrationToken');
  });

  it('grants the fence to one token and retains account deletion without TTL', async () => {
    const dynamo = makeDynamo();
    let quota = quotaItem();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof ScanCommand) return { $metadata: {}, Items: [] };
      if (command instanceof GetCommand) return { $metadata: {}, Item: quota };
      if (command instanceof UpdateCommand) {
        quota = quotaItem({
          deleting: true,
          mutationEpoch: 1,
          deletionToken:
            command.input.ExpressionAttributeValues?.[':deletionToken'],
          deletionStartedAt:
            command.input.ExpressionAttributeValues?.[':deletionStartedAt'],
          retainFence:
            command.input.ExpressionAttributeValues?.[':retainFence'],
        });
      }
      if (command instanceof PutCommand) quota = command.input.Item! as never;
      return { $metadata: {} };
    });
    const adapter = makeAdapter(dynamo);
    const runtimeAdapter = adapter as unknown as {
      beginPantryDeletion: (
        ownerUserId: string,
        options?: { deletionToken?: string; retainFence?: boolean },
      ) => Promise<string>;
      completePantryDeletion: (
        ownerUserId: string,
        deletionToken: string,
        retainFence?: boolean,
      ) => Promise<void>;
    };

    await expect(
      runtimeAdapter.beginPantryDeletion('user-1', {
        deletionToken: 'owner-token',
        retainFence: true,
      }),
    ).resolves.toBe('owner-token');
    await expect(
      runtimeAdapter.beginPantryDeletion('user-1', {
        deletionToken: 'other-token',
        retainFence: true,
      }),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
    const begin = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(begin.input.ExpressionAttributeValues).toMatchObject({
      ':mutationEpoch': 0,
      ':nextEpoch': 1,
      ':deletionToken': 'owner-token',
      ':retainFence': true,
    });

    await runtimeAdapter.completePantryDeletion('user-1', 'owner-token', true);
    const marker = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutCommand) as PutCommand;
    expect(marker.input.Item).toEqual({
      pk: 'PANTRY_QUOTA#user-1',
      entityType: 'PANTRY_QUOTA',
      ownerUserId: 'user-1',
      quotaSchemaVersion: 2,
      mutationEpoch: 1,
      deleting: true,
      deletionToken: 'owner-token',
      deletionStartedAt: expect.any(String),
      retainFence: true,
    });
    expect(marker.input.Item).not.toHaveProperty('expiresAt');
    expect(marker.input.Item).not.toHaveProperty('expiresAtEpochSeconds');
  });

  it('fails completion when the owned fence changes instead of swallowing the CAS failure', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: quotaItem({
            deleting: true,
            mutationEpoch: 1,
            deletionToken: 'owner-token',
            retainFence: false,
          }),
        };
      }
      if (command instanceof ScanCommand) return { $metadata: {}, Items: [] };
      if (command instanceof PutCommand) {
        throw Object.assign(new Error('changed'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      return { $metadata: {} };
    });

    await expect(
      (
        makeAdapter(dynamo) as unknown as {
          completePantryDeletion: (
            ownerUserId: string,
            deletionToken: string,
          ) => Promise<void>;
        }
      ).completePantryDeletion('user-1', 'owner-token'),
    ).rejects.toBeInstanceOf(PantryMutationConflictError);
  });

  it('takes over an abandoned normal reset only after the Lambda safety margin', async () => {
    const dynamo = makeDynamo();
    const oldStartedAt = new Date(Date.now() - 61_000).toISOString();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: quotaItem({
            deleting: true,
            mutationEpoch: 1,
            deletionToken: 'abandoned-token',
            deletionStartedAt: oldStartedAt,
            retainFence: false,
          }),
        };
      }
      return { $metadata: {} };
    });

    await expect(
      makeAdapter(dynamo).beginPantryDeletion('user-1', {
        deletionToken: 'takeover-token',
      }),
    ).resolves.toBe('takeover-token');

    const takeover = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(takeover.input.ConditionExpression).toContain(
      'deletionToken = :previousDeletionToken',
    );
    expect(takeover.input.ExpressionAttributeValues).toMatchObject({
      ':previousDeletionToken': 'abandoned-token',
      ':deletionToken': 'takeover-token',
      ':previousStartedAt': oldStartedAt,
      ':mutationEpoch': 1,
      ':nextEpoch': 2,
    });
  });

  it('promotes an abandoned normal reset to the durable account-deletion fence', async () => {
    const dynamo = makeDynamo();
    const oldStartedAt = new Date(Date.now() - 61_000).toISOString();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: quotaItem({
            deleting: true,
            mutationEpoch: 3,
            deletionToken: 'abandoned-reset-token',
            deletionStartedAt: oldStartedAt,
            retainFence: false,
          }),
        };
      }
      return { $metadata: {} };
    });

    await expect(
      makeAdapter(dynamo).beginPantryDeletion('user-1', {
        deletionToken: 'account-job-token',
        retainFence: true,
      }),
    ).resolves.toBe('account-job-token');

    const takeover = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(takeover.input.UpdateExpression).toContain(
      'retainFence = :nextRetainFence',
    );
    expect(takeover.input.ConditionExpression).toContain(
      'retainFence = :previousRetainFence',
    );
    expect(takeover.input.ExpressionAttributeValues).toMatchObject({
      ':previousDeletionToken': 'abandoned-reset-token',
      ':deletionToken': 'account-job-token',
      ':previousStartedAt': oldStartedAt,
      ':mutationEpoch': 3,
      ':nextEpoch': 4,
      ':previousRetainFence': false,
      ':nextRetainFence': true,
    });
  });

  it('rebuilds quota authoritatively before aborting a failed normal reset', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: quotaItem({
            deleting: true,
            mutationEpoch: 4,
            deletionToken: 'owner-token',
            deletionStartedAt: new Date().toISOString(),
            retainFence: false,
          }),
        };
      }
      if (command instanceof ScanCommand) return { $metadata: {}, Items: [] };
      return { $metadata: {} };
    });

    await (
      makeAdapter(dynamo) as unknown as {
        abortPantryDeletion: (
          ownerUserId: string,
          deletionToken: string,
        ) => Promise<void>;
      }
    ).abortPantryDeletion('user-1', 'owner-token');

    const release = dynamo.send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutCommand) as PutCommand;
    expect(release.input.Item).toMatchObject({
      pk: 'PANTRY_QUOTA#user-1',
      mutationEpoch: 4,
      deleting: false,
      activeInventoryLots: 0,
      activeProductTypes: 0,
    });
    expect(release.input.ConditionExpression).toContain(
      'deletionToken = :deletionToken',
    );
  });

  it('commits and decodes a completed reset receipt with the fence release', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return {
          $metadata: {},
          Item: quotaItem({
            deleting: true,
            mutationEpoch: 1,
            deletionToken: 'reset-operation',
            deletionStartedAt: new Date().toISOString(),
            retainFence: false,
          }),
        };
      }
      if (command instanceof ScanCommand) return { $metadata: {}, Items: [] };
      return { $metadata: {} };
    });
    const adapter = makeAdapter(dynamo);
    const receipt = deleteReceipt();

    await (
      adapter as unknown as {
        completePantryDeletion: (
          ownerUserId: string,
          deletionToken: string,
          retainFence: boolean,
          receipt: PantryDeletionReceipt,
        ) => Promise<void>;
      }
    ).completePantryDeletion('user-1', 'reset-operation', false, receipt);

    const transaction = dynamo.send.mock.calls
      .map(([command]) => command)
      .find(
        (command) => command instanceof TransactWriteCommand,
      ) as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems?.[1].Put?.Item).toMatchObject({
      entityType: 'PANTRY_OPERATION',
      operation: 'delete_pantry_data',
      response: receipt.response,
      expiresAtEpochSeconds: Math.floor(receipt.expiresAt.getTime() / 1000),
    });

    const persisted = transaction.input.TransactItems?.[1].Put?.Item;
    dynamo.send.mockResolvedValueOnce({ $metadata: {}, Item: persisted });
    await expect(adapter.findReceipt(receipt)).resolves.toMatchObject({
      response: receipt.response,
    });
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
      gsi2pk: 'PANTRY_OPERATION_OWNER#user-1',
      gsi2sk: expect.stringContaining('CREATED#'),
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

  it('backfills archived counters from authoritative tables before the first mutation', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) return { $metadata: {} };
      if (command instanceof ScanCommand) {
        if (command.input.TableName === 'lots') {
          return {
            $metadata: {},
            Items: [
              {
                entityType: 'INVENTORY_LOT',
                id: 'active-lot',
                userId: 'user-1',
                productTypeId: 'type-1',
                updatedAt: '2026-09-01T00:00:00.000Z',
              },
              {
                entityType: 'INVENTORY_LOT',
                id: 'archived-lot',
                userId: 'user-1',
                productTypeId: 'type-1',
                archivedAt: '2026-08-01T00:00:00.000Z',
                updatedAt: '2026-08-01T00:00:00.000Z',
              },
            ],
          };
        }
        if (command.input.TableName === 'types') {
          return {
            $metadata: {},
            Items: [
              {
                entityType: 'PRODUCT_TYPE',
                id: 'type-1',
                userId: 'user-1',
                baseName: 'Leche',
                archivedAt: '2026-08-01T00:00:00.000Z',
              },
            ],
          };
        }
        return { $metadata: {}, Items: [] };
      }
      return { $metadata: {} };
    });

    await makeAdapter(dynamo).createInventoryLot(makeLot(1));

    const put = dynamo.send.mock.calls
      .map(([command]) => command)
      .find(
        (command) =>
          command instanceof PutCommand &&
          command.input.Item?.quotaSchemaVersion === 2,
      ) as PutCommand;
    expect(put.input.Item).toMatchObject({
      activeInventoryLots: 1,
      archivedInventoryLots: 1,
      activeProductTypes: 0,
      archivedProductTypes: 1,
      lotsByProductType: { 'type-1': 1 },
      archivedLotsByProductType: { 'type-1': 1 },
    });
    expect(
      dynamo.send.mock.calls
        .filter(([command]) => command instanceof ScanCommand)
        .every(
          ([command]) => (command as ScanCommand).input.ConsistentRead === true,
        ),
    ).toBe(true);
  });

  it('does not attach autonomous TTL to quota-tracked archived records', async () => {
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
    ).toBeUndefined();
  });

  it('moves inventory lots between active and archived quotas atomically', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) =>
      command instanceof GetCommand
        ? { $metadata: {}, Item: quotaItem() }
        : { $metadata: {} },
    );
    const adapter = makeAdapter(dynamo);
    const lot = makeLot(1);
    let expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.archive();
    await adapter.archiveInventoryLot(expected, lot);
    expected = InventoryLot.fromPrimitives(lot.toPrimitives());
    lot.restore();
    await adapter.restoreInventoryLot(expected, lot);

    const transactions = dynamo.send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is TransactWriteCommand =>
          command instanceof TransactWriteCommand,
      );
    expect(transactions[0].input.TransactItems?.[1].Update).toMatchObject({
      UpdateExpression: expect.stringContaining('archivedLotsByProductType'),
      ConditionExpression: expect.stringContaining(
        'archivedInventoryLots < :archivedMaximum',
      ),
      ExpressionAttributeValues: expect.objectContaining({
        ':archivedMaximum': 250,
      }),
    });
    expect(transactions[1].input.TransactItems?.[1].Update).toMatchObject({
      UpdateExpression: expect.stringContaining('archivedLotsByProductType'),
      ConditionExpression: expect.stringContaining(
        'archivedInventoryLots >= :delta',
      ),
    });
  });

  it('moves product types between active and archived quotas atomically', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) =>
      command instanceof GetCommand
        ? { $metadata: {}, Item: quotaItem() }
        : { $metadata: {} },
    );
    const adapter = makeAdapter(dynamo);
    const productType = makeProductType('type-archive');
    let expected = ProductType.fromPrimitives(productType.toPrimitives());
    productType.archive();
    await adapter.archiveProductType(expected, productType);
    expected = ProductType.fromPrimitives(productType.toPrimitives());
    productType.restore();
    await adapter.restoreProductType(expected, productType);

    const transactions = dynamo.send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is TransactWriteCommand =>
          command instanceof TransactWriteCommand,
      );
    expect(transactions[0].input.TransactItems?.[1].Update).toMatchObject({
      UpdateExpression: expect.stringContaining('archivedProductTypes'),
      ConditionExpression: expect.stringContaining(
        'archivedProductTypes < :archivedMaximum',
      ),
      ExpressionAttributeValues: expect.objectContaining({
        ':archivedMaximum': 250,
      }),
    });
    expect(transactions[1].input.TransactItems?.[1].Update).toMatchObject({
      UpdateExpression: expect.stringContaining('archivedProductTypes'),
      ConditionExpression: expect.stringContaining(
        'archivedProductTypes >= :one',
      ),
    });
  });

  it('decrements archived quotas on permanent deletion', async () => {
    const dynamo = makeDynamo();
    dynamo.send.mockImplementation(async (command) =>
      command instanceof GetCommand
        ? { $metadata: {}, Item: quotaItem() }
        : { $metadata: {} },
    );
    const adapter = makeAdapter(dynamo);
    const lot = makeLot(1);
    lot.archive();
    const productType = makeProductType('type-delete');
    productType.archive();

    await adapter.deleteInventoryLot(lot);
    await adapter.deleteProductType(productType);

    const transactions = dynamo.send.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is TransactWriteCommand =>
          command instanceof TransactWriteCommand,
      );
    expect(transactions[0].input.TransactItems?.[1].Update).toMatchObject({
      UpdateExpression: expect.stringContaining('archivedLotsByProductType'),
    });
    expect(transactions[1].input.TransactItems?.[1].Update).toMatchObject({
      UpdateExpression: expect.stringContaining('archivedProductTypes'),
      ConditionExpression: expect.stringContaining('archivedLotsByProductType'),
    });
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
      ConditionExpression: expect.stringContaining(
        'activeProductTypes < :maximum AND attribute_not_exists(productTypeNames.#name) AND deleting = :deleting',
      ),
    });
    expect(listCommand.input.TransactItems?.[1].Update).toMatchObject({
      ConditionExpression: expect.stringContaining(
        '#counter < :maximum AND deleting = :deleting',
      ),
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
    ).toContain('mutationEpoch = :mutationEpoch');
    expect(shareWrite.input.TransactItems?.[0].Put?.Item).toMatchObject({
      entityType: 'SHOPPING_SHARE',
      expiresAtEpochSeconds: 1788825600,
    });
    expect(
      shareWrite.input.TransactItems?.[1].ConditionCheck?.ConditionExpression,
    ).toContain('mutationEpoch = :mutationEpoch');
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

function deleteReceipt() {
  const createdAt = new Date();
  return {
    operationId: 'reset-operation',
    ownerUserId: 'user-1',
    operation: 'delete_pantry_data' as const,
    requestHash: 'delete-request-hash',
    response: {
      deletedInventoryLotCount: 5,
      deletedProductTypeCount: 3,
      deletedShoppingListCount: 1,
      deletedShoppingShareCount: 2,
      deletedWasteEventCount: 4,
    },
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 7 * 86400_000),
  };
}

function quotaItem(overrides: Record<string, unknown> = {}) {
  return {
    pk: 'PANTRY_QUOTA#user-1',
    entityType: 'PANTRY_QUOTA',
    ownerUserId: 'user-1',
    quotaSchemaVersion: 2,
    mutationEpoch: 0,
    deleting: false,
    activeProductTypes: 49,
    archivedProductTypes: 2,
    activeInventoryLots: 100,
    archivedInventoryLots: 3,
    savedShoppingLists: 2,
    lotsByProductType: {},
    archivedLotsByProductType: {},
    productTypeNames: {},
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
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
