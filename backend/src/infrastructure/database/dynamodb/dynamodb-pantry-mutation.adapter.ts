import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  CloseShoppingPurchaseMutation,
  ConsumeInventoryLotMutation,
  IdempotencyPayloadConflictError,
  IdempotentMutationResult,
  PantryMutationConflictError,
  PantryMutationPort,
  PantryOperationLookup,
  PantryOperationReceipt,
  PantryQuotaExceededError,
} from '../../../application/ports/pantry-mutation.port';
import {
  MAX_ACTIVE_INVENTORY_LOTS_PER_USER,
  MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
  MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE,
  MAX_SAVED_SHOPPING_LISTS_PER_USER,
} from '../../../application/constants/query-limits';
import { InventoryLotPrimitives } from '../../../domain/entities/inventory-lot.entity';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import {
  ProductType,
  ProductTypePrimitives,
} from '../../../domain/entities/product-type.entity';
import { WasteEventPrimitives } from '../../../domain/entities/waste-event.entity';
import {
  ShoppingList,
  ShoppingListPrimitives,
} from '../../../domain/entities/shopping-list.entity';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { stableRequestHash } from '../../../application/utils/pantry-idempotency';
import { getArchivedRecordRetentionExpiresAt } from '../../../application/policies/retention-policy';
import {
  Product,
  ProductPrimitives,
} from '../../../domain/entities/product.entity';
import {
  ShoppingShare,
  ShoppingSharePrimitives,
} from '../../../domain/entities/shopping-share.entity';

type TransactionItems = NonNullable<TransactWriteCommandInput['TransactItems']>;

interface PantryOperationItem {
  pk: string;
  entityType: 'PANTRY_OPERATION';
  operationId: string;
  ownerUserId: string;
  operation: PantryOperationReceipt['operation'];
  requestHash: string;
  response: PersistedLot | PersistedLot[] | null;
  createdAt: string;
  expiresAt: string;
  expiresAtEpochSeconds: number;
}

interface PantryQuotaItem {
  pk: string;
  entityType: 'PANTRY_QUOTA';
  ownerUserId: string;
  activeProductTypes: number;
  activeInventoryLots: number;
  savedShoppingLists: number;
  lotsByProductType: Record<string, number>;
  productTypeNames: Record<string, string>;
  updatedAt: string;
}

type PersistedLot = Omit<
  InventoryLotPrimitives,
  'expiresAt' | 'purchaseDate' | 'archivedAt' | 'createdAt' | 'updatedAt'
> & {
  expiresAt?: string;
  purchaseDate?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class DynamoDbPantryMutationAdapter implements PantryMutationPort {
  private readonly usersTable: string;
  private readonly productTypesTable: string;
  private readonly inventoryLotsTable: string;
  private readonly productsTable: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    private readonly configService: ConfigService,
  ) {
    this.usersTable = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
    this.productTypesTable = configService.getOrThrow<string>(
      'DYNAMODB_PRODUCT_TYPES_TABLE',
    );
    this.inventoryLotsTable = configService.getOrThrow<string>(
      'DYNAMODB_INVENTORY_LOTS_TABLE',
    );
    this.productsTable = configService.getOrThrow<string>(
      'DYNAMODB_PRODUCTS_TABLE',
    );
  }

  async findReceipt(
    lookup: PantryOperationLookup,
  ): Promise<PantryOperationReceipt | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.usersTable,
        Key: { pk: operationKey(lookup.operationId) },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) {
      return null;
    }

    const receipt = fromOperationItem(result.Item as PantryOperationItem);
    if (
      receipt.ownerUserId !== lookup.ownerUserId ||
      receipt.operation !== lookup.operation ||
      receipt.requestHash !== lookup.requestHash
    ) {
      throw new IdempotencyPayloadConflictError();
    }
    if (!(receipt.expiresAt.getTime() > Date.now())) {
      throw new PantryMutationConflictError(
        'Idempotency-Key has expired; inspect inventory before starting a new operation',
      );
    }
    return receipt;
  }

  async consume(
    mutation: ConsumeInventoryLotMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives | null>> {
    await this.ensureQuota(mutation.receipt.ownerUserId);
    const response = mutation.updatedLot?.toPrimitives() ?? null;
    const transactionItems: TransactionItems = [
      receiptPut(this.usersTable, mutation.receipt, response),
      mutation.updatedLot
        ? {
            Put: {
              TableName: this.inventoryLotsTable,
              Item: toInventoryLotItem(mutation.updatedLot.toPrimitives()),
              ConditionExpression:
                'entityType = :lotType AND userId = :owner AND updatedAt = :expectedUpdatedAt AND quantity = :quantity AND attribute_not_exists(archivedAt)',
              ExpressionAttributeValues: {
                ':lotType': 'INVENTORY_LOT',
                ':owner': mutation.receipt.ownerUserId,
                ':expectedUpdatedAt':
                  mutation.expectedLot.updatedAt.toISOString(),
                ':quantity': mutation.expectedLot.quantity,
              },
            },
          }
        : {
            Delete: {
              TableName: this.inventoryLotsTable,
              Key: { id: mutation.expectedLot.id.toString() },
              ConditionExpression:
                'entityType = :lotType AND userId = :owner AND updatedAt = :expectedUpdatedAt AND quantity = :quantity AND attribute_not_exists(archivedAt)',
              ExpressionAttributeValues: {
                ':lotType': 'INVENTORY_LOT',
                ':owner': mutation.receipt.ownerUserId,
                ':expectedUpdatedAt':
                  mutation.expectedLot.updatedAt.toISOString(),
                ':quantity': mutation.expectedLot.quantity,
              },
            },
          },
    ];

    if (mutation.wasteEvent) {
      transactionItems.push({
        Put: {
          TableName: this.inventoryLotsTable,
          Item: toWasteEventItem(mutation.wasteEvent.toPrimitives()),
          ConditionExpression: 'attribute_not_exists(id)',
        },
      });
    }

    if (!mutation.updatedLot) {
      transactionItems.push(
        decrementLotQuota(
          this.usersTable,
          mutation.receipt.ownerUserId,
          mutation.expectedLot.productTypeId.toString(),
          mutation.receipt.createdAt,
        ),
      );
    } else {
      transactionItems.push(
        quotaAvailable(this.usersTable, mutation.receipt.ownerUserId),
      );
    }

    const quotaIndex = transactionItems.length - 1;
    transactionItems.push(
      productTypeAvailableCheck(
        this.productTypesTable,
        mutation.receipt.ownerUserId,
        mutation.expectedLot.productTypeId.toString(),
      ),
    );

    return this.commit(
      mutation.receipt,
      response,
      transactionItems,
      quotaIndex,
    );
  }

  async checkout(
    mutation: CloseShoppingPurchaseMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives[]>> {
    await this.ensureQuota(mutation.receipt.ownerUserId);
    const response = mutation.lots.map((lot) => lot.toPrimitives());
    const transactionItems: TransactionItems = [
      receiptPut(this.usersTable, mutation.receipt, response),
      ...mutation.lots.map((lot) => ({
        Put: {
          TableName: this.inventoryLotsTable,
          Item: toInventoryLotItem(lot.toPrimitives()),
          ConditionExpression: 'attribute_not_exists(id)',
        },
      })),
      ...mutation.productTypes.map((change) =>
        change.changed
          ? {
              Put: {
                TableName: this.productTypesTable,
                Item: toProductTypeItem(change.updated.toPrimitives()),
                ConditionExpression:
                  'userId = :owner AND updatedAt = :expectedUpdatedAt AND attribute_not_exists(archivedAt) AND attribute_not_exists(deleting)',
                ExpressionAttributeValues: {
                  ':owner': mutation.receipt.ownerUserId,
                  ':expectedUpdatedAt': change.expected.updatedAt.toISOString(),
                },
              },
            }
          : {
              ConditionCheck: {
                TableName: this.productTypesTable,
                Key: { id: change.expected.id.toString() },
                ConditionExpression:
                  'userId = :owner AND updatedAt = :expectedUpdatedAt AND attribute_not_exists(archivedAt) AND attribute_not_exists(deleting)',
                ExpressionAttributeValues: {
                  ':owner': mutation.receipt.ownerUserId,
                  ':expectedUpdatedAt': change.expected.updatedAt.toISOString(),
                },
              },
            },
      ),
      incrementCheckoutQuota(
        this.usersTable,
        mutation.receipt.ownerUserId,
        mutation.lots.map((lot) => lot.productTypeId.toString()),
        mutation.receipt.createdAt,
      ),
    ];

    if (transactionItems.length > 100) {
      throw new PantryMutationConflictError(
        'Checkout exceeds DynamoDB transaction capacity',
      );
    }

    return this.commit(
      mutation.receipt,
      response,
      transactionItems,
      transactionItems.length - 1,
    );
  }

  async createInventoryLot(lot: InventoryLot): Promise<InventoryLot> {
    await this.ensureQuota(lot.userId.toString());
    const productTypeId = lot.productTypeId.toString();
    const transactionItems: TransactionItems = [
      {
        Put: {
          TableName: this.inventoryLotsTable,
          Item: toInventoryLotItem(lot.toPrimitives()),
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
      incrementSingleLotQuota(
        this.usersTable,
        lot.userId.toString(),
        productTypeId,
        lot.updatedAt,
      ),
      activeProductTypeCheck(this.productTypesTable, lot),
    ];
    await this.commitQuotaMutation(
      transactionItems,
      1,
      'Pantry inventory lot quota exceeded',
    );
    return lot;
  }

  async archiveInventoryLot(
    expected: InventoryLot,
    archived: InventoryLot,
  ): Promise<InventoryLot> {
    await this.ensureQuota(expected.userId.toString());
    const transactionItems: TransactionItems = [
      conditionalLotPut(
        this.inventoryLotsTable,
        expected,
        archived,
        expected.userId.toString(),
      ),
    ];
    if (!expected.archivedAt && archived.archivedAt) {
      transactionItems.push(
        decrementLotQuota(
          this.usersTable,
          expected.userId.toString(),
          expected.productTypeId.toString(),
          archived.updatedAt,
        ),
      );
    } else {
      transactionItems.push(
        quotaAvailable(this.usersTable, expected.userId.toString()),
      );
    }
    const quotaIndex = transactionItems.length - 1;
    transactionItems.push(
      productTypeAvailableCheck(
        this.productTypesTable,
        expected.userId.toString(),
        expected.productTypeId.toString(),
      ),
    );
    await this.commitQuotaMutation(
      transactionItems,
      quotaIndex,
      'Pantry quota is inconsistent',
    );
    return archived;
  }

  async restoreInventoryLot(
    expected: InventoryLot,
    restored: InventoryLot,
  ): Promise<InventoryLot> {
    await this.ensureQuota(expected.userId.toString());
    const transactionItems: TransactionItems = [
      conditionalLotPut(
        this.inventoryLotsTable,
        expected,
        restored,
        expected.userId.toString(),
      ),
    ];
    if (expected.archivedAt && !restored.archivedAt) {
      transactionItems.push(
        incrementSingleLotQuota(
          this.usersTable,
          expected.userId.toString(),
          expected.productTypeId.toString(),
          restored.updatedAt,
        ),
      );
    } else {
      transactionItems.push(
        quotaAvailable(this.usersTable, expected.userId.toString()),
      );
    }
    const quotaIndex = transactionItems.length - 1;
    transactionItems.push(
      activeProductTypeCheck(this.productTypesTable, restored),
    );
    await this.commitQuotaMutation(
      transactionItems,
      quotaIndex,
      'Pantry inventory lot quota exceeded',
    );
    return restored;
  }

  async createProductType(productType: ProductType): Promise<ProductType> {
    await this.ensureQuota(productType.userId.toString());
    const transactionItems: TransactionItems = [
      {
        Put: {
          TableName: this.productTypesTable,
          Item: toProductTypeItem(productType.toPrimitives()),
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
      productTypeQuota(this.usersTable, productType, 1),
    ];
    await this.commitQuotaMutation(
      transactionItems,
      1,
      'Active product type quota exceeded',
    );
    return productType;
  }

  async archiveProductType(
    expected: ProductType,
    archived: ProductType,
  ): Promise<ProductType> {
    await this.ensureQuota(expected.userId.toString());
    const transactionItems: TransactionItems = [
      conditionalProductTypePut(
        this.productTypesTable,
        expected,
        archived,
        expected.userId.toString(),
      ),
    ];
    if (!expected.archivedAt && archived.archivedAt) {
      transactionItems.push(productTypeQuota(this.usersTable, archived, -1));
    } else {
      transactionItems.push(
        quotaAvailable(this.usersTable, expected.userId.toString()),
      );
    }
    await this.commitQuotaMutation(
      transactionItems,
      transactionItems.length - 1,
      'Pantry quota is inconsistent',
    );
    return archived;
  }

  async restoreProductType(
    expected: ProductType,
    restored: ProductType,
  ): Promise<ProductType> {
    await this.ensureQuota(expected.userId.toString());
    const transactionItems: TransactionItems = [
      conditionalProductTypePut(
        this.productTypesTable,
        expected,
        restored,
        expected.userId.toString(),
      ),
    ];
    if (expected.archivedAt && !restored.archivedAt) {
      transactionItems.push(productTypeQuota(this.usersTable, restored, 1));
    } else {
      transactionItems.push(
        quotaAvailable(this.usersTable, expected.userId.toString()),
      );
    }
    await this.commitQuotaMutation(
      transactionItems,
      transactionItems.length - 1,
      'Active product type quota exceeded',
    );
    return restored;
  }

  async createShoppingList(list: ShoppingList): Promise<ShoppingList> {
    await this.ensureQuota(list.ownerUserId);
    const transactionItems: TransactionItems = [
      {
        Put: {
          TableName: this.usersTable,
          Item: toShoppingListItem(list.toPrimitives()),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      incrementSimpleQuota(
        this.usersTable,
        list.ownerUserId,
        'savedShoppingLists',
        MAX_SAVED_SHOPPING_LISTS_PER_USER,
        list.toPrimitives().updatedAt,
      ),
    ];
    await this.commitQuotaMutation(
      transactionItems,
      1,
      'Saved shopping list quota exceeded',
    );
    return list;
  }

  async createProduct(product: Product): Promise<Product> {
    const ownerUserId = product.userId.toString();
    await this.ensureQuota(ownerUserId);
    await this.commitQuotaMutation(
      [
        {
          Put: {
            TableName: this.productsTable,
            Item: toProductItem(product.toPrimitives()),
            ConditionExpression: 'attribute_not_exists(id)',
          },
        },
        quotaAvailable(this.usersTable, ownerUserId),
      ],
      1,
      'Pantry is being deleted',
    );
    return product;
  }

  async updateProduct(expected: Product, updated: Product): Promise<Product> {
    const ownerUserId = expected.userId.toString();
    await this.ensureQuota(ownerUserId);
    await this.commitQuotaMutation(
      [
        {
          Put: {
            TableName: this.productsTable,
            Item: toProductItem(updated.toPrimitives()),
            ConditionExpression:
              'entityType = :entityType AND userId = :owner AND updatedAt = :expectedUpdatedAt',
            ExpressionAttributeValues: {
              ':entityType': 'PRODUCT',
              ':owner': ownerUserId,
              ':expectedUpdatedAt': expected.updatedAt.toISOString(),
            },
          },
        },
        quotaAvailable(this.usersTable, ownerUserId),
      ],
      1,
      'Pantry is being deleted',
    );
    return updated;
  }

  async createShoppingShare(share: ShoppingShare): Promise<ShoppingShare> {
    await this.ensureQuota(share.ownerUserId);
    await this.commitQuotaMutation(
      [
        {
          Put: {
            TableName: this.usersTable,
            Item: toShoppingShareItem(share.toPrimitives()),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        quotaAvailable(this.usersTable, share.ownerUserId),
      ],
      1,
      'Pantry is being deleted',
    );
    return share;
  }

  async updateShoppingShare(
    expected: ShoppingShare,
    updated: ShoppingShare,
  ): Promise<ShoppingShare> {
    const expectedPrimitives = expected.toPrimitives();
    await this.ensureQuota(expected.ownerUserId);
    await this.commitQuotaMutation(
      [
        {
          Put: {
            TableName: this.usersTable,
            Item: toShoppingShareItem(updated.toPrimitives()),
            ConditionExpression:
              'entityType = :entityType AND ownerUserId = :owner AND updatedAt = :expectedUpdatedAt',
            ExpressionAttributeValues: {
              ':entityType': 'SHOPPING_SHARE',
              ':owner': expected.ownerUserId,
              ':expectedUpdatedAt': expectedPrimitives.updatedAt.toISOString(),
            },
          },
        },
        quotaAvailable(this.usersTable, expected.ownerUserId),
      ],
      1,
      'Pantry is being deleted',
    );
    return updated;
  }

  async deleteShoppingList(list: ShoppingList): Promise<void> {
    await this.ensureQuota(list.ownerUserId);
    const primitives = list.toPrimitives();
    const transactionItems: TransactionItems = [
      {
        Delete: {
          TableName: this.usersTable,
          Key: { pk: shoppingListKey(primitives.id) },
          ConditionExpression:
            'entityType = :entityType AND ownerUserId = :owner',
          ExpressionAttributeValues: {
            ':entityType': 'SHOPPING_LIST',
            ':owner': list.ownerUserId,
          },
        },
      },
      decrementSimpleQuota(
        this.usersTable,
        list.ownerUserId,
        'savedShoppingLists',
        primitives.updatedAt,
      ),
    ];
    await this.commitQuotaMutation(
      transactionItems,
      1,
      'Pantry quota is inconsistent',
    );
  }

  async deleteInventoryLot(lot: InventoryLot): Promise<void> {
    await this.ensureQuota(lot.userId.toString());
    const items: TransactionItems = [
      {
        Delete: {
          TableName: this.inventoryLotsTable,
          Key: { id: lot.id.toString() },
          ConditionExpression:
            'userId = :owner AND updatedAt = :updatedAt AND quantity = :quantity',
          ExpressionAttributeValues: {
            ':owner': lot.userId.toString(),
            ':updatedAt': lot.updatedAt.toISOString(),
            ':quantity': lot.quantity,
          },
        },
      },
      lot.archivedAt
        ? quotaAvailable(this.usersTable, lot.userId.toString())
        : decrementLotQuota(
            this.usersTable,
            lot.userId.toString(),
            lot.productTypeId.toString(),
            new Date(),
          ),
    ];
    await this.commitQuotaMutation(items, 1, 'Pantry quota is inconsistent');
  }

  async deleteProductType(productType: ProductType): Promise<void> {
    await this.ensureQuota(productType.userId.toString());
    await this.commitQuotaMutation(
      [
        {
          Delete: {
            TableName: this.productTypesTable,
            Key: { id: productType.id.toString() },
            ConditionExpression:
              'userId = :owner AND updatedAt = :updatedAt AND attribute_exists(archivedAt) AND deleting = :deleting',
            ExpressionAttributeValues: {
              ':owner': productType.userId.toString(),
              ':updatedAt': productType.updatedAt.toISOString(),
              ':deleting': true,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: this.usersTable,
            Key: { pk: quotaKey(productType.userId.toString()) },
            ConditionExpression:
              'attribute_not_exists(deleting) AND (attribute_not_exists(lotsByProductType.#type) OR lotsByProductType.#type = :zero)',
            ExpressionAttributeNames: { '#type': productType.id.toString() },
            ExpressionAttributeValues: { ':zero': 0 },
          },
        },
      ],
      1,
      'Product type still has active inventory',
    );
  }

  async beginProductTypeDeletion(productType: ProductType): Promise<void> {
    const ownerUserId = productType.userId.toString();
    await this.ensureQuota(ownerUserId);
    await this.commitQuotaMutation(
      [
        {
          Update: {
            TableName: this.productTypesTable,
            Key: { id: productType.id.toString() },
            UpdateExpression:
              'SET deleting = :deleting REMOVE expiresAtEpochSeconds',
            ConditionExpression:
              'userId = :owner AND updatedAt = :updatedAt AND attribute_exists(archivedAt)',
            ExpressionAttributeValues: {
              ':owner': ownerUserId,
              ':updatedAt': productType.updatedAt.toISOString(),
              ':deleting': true,
            },
          },
        },
        quotaAvailable(this.usersTable, ownerUserId),
      ],
      1,
      'Pantry is being deleted',
    );
  }

  async updateProductType(
    expected: ProductType,
    updated: ProductType,
  ): Promise<ProductType> {
    await this.ensureQuota(expected.userId.toString());
    await this.commitQuotaMutation(
      [
        conditionalProductTypePut(
          this.productTypesTable,
          expected,
          updated,
          expected.userId.toString(),
        ),
        quotaAvailable(this.usersTable, expected.userId.toString()),
      ],
      1,
      'Pantry is being deleted',
    );
    return updated;
  }

  async beginPantryDeletion(
    ownerUserId: string,
    preserveDeletionLockUntil?: Date,
  ): Promise<void> {
    await this.ensureQuota(ownerUserId);
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: this.usersTable,
        Key: { pk: quotaKey(ownerUserId) },
        UpdateExpression: preserveDeletionLockUntil
          ? 'SET deleting = :deleting, expiresAt = :expiresAt, expiresAtEpochSeconds = :expiresAtEpochSeconds'
          : 'SET deleting = :deleting',
        ExpressionAttributeValues: {
          ':deleting': true,
          ...(preserveDeletionLockUntil
            ? {
                ':expiresAt': preserveDeletionLockUntil.toISOString(),
                ':expiresAtEpochSeconds': Math.floor(
                  preserveDeletionLockUntil.getTime() / 1000,
                ),
              }
            : {}),
        },
      }),
    );
  }

  async completePantryDeletion(
    ownerUserId: string,
    preserveDeletionLockUntil?: Date,
  ): Promise<void> {
    // The regular repositories use GSIs; a strongly consistent final sweep includes just-committed writes.
    for (const table of [
      this.inventoryLotsTable,
      this.productTypesTable,
      this.productsTable,
    ]) {
      const remaining = await this.scanAll(table, ownerUserId);
      for (const item of remaining) {
        await this.dynamoDb.send(
          new DeleteCommand({ TableName: table, Key: { id: item.id } }),
        );
      }
    }
    const items = await this.scanAll(this.usersTable, ownerUserId);
    for (const item of items.filter((item) =>
      ['PANTRY_OPERATION', 'SHOPPING_LIST', 'SHOPPING_SHARE'].includes(
        String(item.entityType),
      ),
    )) {
      await this.dynamoDb.send(
        new DeleteCommand({ TableName: this.usersTable, Key: { pk: item.pk } }),
      );
    }
    if (preserveDeletionLockUntil) {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: this.usersTable,
          Item: {
            pk: quotaKey(ownerUserId),
            entityType: 'PANTRY_QUOTA',
            ownerUserId,
            deleting: true,
            expiresAt: preserveDeletionLockUntil.toISOString(),
            expiresAtEpochSeconds: Math.floor(
              preserveDeletionLockUntil.getTime() / 1000,
            ),
          },
        }),
      );
      return;
    }
    try {
      await this.dynamoDb.send(
        new DeleteCommand({
          TableName: this.usersTable,
          Key: { pk: quotaKey(ownerUserId) },
          // A normal reset finishing late must not unlock a concurrently deleted account.
          ConditionExpression: 'attribute_not_exists(expiresAtEpochSeconds)',
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
    }
  }

  private async commitQuotaMutation(
    transactionItems: TransactionItems,
    quotaActionIndex: number,
    quotaMessage: string,
  ): Promise<void> {
    for (const action of transactionItems) {
      const item = action.Put?.Item;
      if (item?.archivedAt && typeof item.archivedAt === 'string') {
        const expiresAt = getArchivedRecordRetentionExpiresAt(
          new Date(item.archivedAt),
          this.configService,
        );
        if (expiresAt)
          item.expiresAtEpochSeconds = Math.floor(expiresAt.getTime() / 1000);
      }
    }
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({ TransactItems: transactionItems }),
      );
    } catch (error) {
      if (!isTransactionCanceled(error)) {
        throw error;
      }
      if (
        error.CancellationReasons?.[quotaActionIndex]?.Code ===
        'ConditionalCheckFailed'
      ) {
        throw new PantryQuotaExceededError(quotaMessage);
      }
      throw new PantryMutationConflictError();
    }
  }

  private async commit<
    T extends InventoryLotPrimitives | InventoryLotPrimitives[] | null,
  >(
    receipt: PantryOperationLookup,
    response: T,
    transactionItems: TransactionItems,
    quotaActionIndex: number,
  ): Promise<IdempotentMutationResult<T>> {
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: transactionItems,
          ClientRequestToken: stableRequestHash(transactionItems).slice(0, 36),
        }),
      );
      return { value: response, replayed: false };
    } catch (error) {
      if (!isTransactionCanceled(error)) {
        throw error;
      }

      const replay = await this.findReceipt(receipt);
      if (replay) {
        return { value: replay.response as T, replayed: true };
      }
      if (
        error.CancellationReasons?.[quotaActionIndex]?.Code ===
        'ConditionalCheckFailed'
      ) {
        throw new PantryQuotaExceededError('Pantry quota exceeded');
      }
      throw new PantryMutationConflictError();
    }
  }

  private async ensureQuota(ownerUserId: string): Promise<void> {
    const existing = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.usersTable,
        Key: { pk: quotaKey(ownerUserId) },
        ConsistentRead: true,
      }),
    );
    if (existing.Item) {
      return;
    }

    const [lots, productTypes, shoppingLists] = await Promise.all([
      this.scanAll(this.inventoryLotsTable, ownerUserId),
      this.scanAll(this.productTypesTable, ownerUserId),
      this.scanAll(this.usersTable, ownerUserId),
    ]);
    const activeLots = lots.filter(
      (item) =>
        item.entityType === 'INVENTORY_LOT' &&
        item.userId === ownerUserId &&
        !item.archivedAt,
    );
    const activeProductTypes = productTypes.filter(
      (item) =>
        item.entityType === 'PRODUCT_TYPE' &&
        item.userId === ownerUserId &&
        !item.archivedAt,
    );
    const savedShoppingLists = shoppingLists.filter(
      (item) =>
        item.entityType === 'SHOPPING_LIST' && item.ownerUserId === ownerUserId,
    );
    const lotsByProductType = activeLots.reduce<Record<string, number>>(
      (counts, item) => {
        const productTypeId = String(item.productTypeId);
        counts[productTypeId] = (counts[productTypeId] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const quota: PantryQuotaItem = {
      pk: quotaKey(ownerUserId),
      entityType: 'PANTRY_QUOTA',
      ownerUserId,
      activeProductTypes: activeProductTypes.length,
      activeInventoryLots: activeLots.length,
      savedShoppingLists: savedShoppingLists.length,
      lotsByProductType,
      productTypeNames: Object.fromEntries(
        activeProductTypes.map((item) => [
          stableRequestHash(
            String(item.baseName).trim().toLocaleLowerCase('es'),
          ),
          String(item.id),
        ]),
      ),
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.dynamoDb.send(
        new PutCommand({
          TableName: this.usersTable,
          Item: quota,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) {
        throw error;
      }
    }
  }

  private async scanAll(
    tableName: string,
    ownerUserId: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.dynamoDb.send(
        new ScanCommand({
          TableName: tableName,
          ConsistentRead: true,
          FilterExpression: 'userId = :owner OR ownerUserId = :owner',
          ExpressionAttributeValues: { ':owner': ownerUserId },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      items.push(...((result.Items ?? []) as Record<string, unknown>[]));
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return items;
  }
}

function receiptPut(
  tableName: string,
  receipt: PantryOperationLookup,
  response: InventoryLotPrimitives | InventoryLotPrimitives[] | null,
): TransactionItems[number] {
  return {
    Put: {
      TableName: tableName,
      Item: toOperationItem(receipt, response),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

function toOperationItem(
  receipt: PantryOperationLookup,
  response: InventoryLotPrimitives | InventoryLotPrimitives[] | null,
): PantryOperationItem {
  return {
    pk: operationKey(receipt.operationId),
    entityType: 'PANTRY_OPERATION',
    operationId: receipt.operationId,
    ownerUserId: receipt.ownerUserId,
    operation: receipt.operation,
    requestHash: receipt.requestHash,
    response: Array.isArray(response)
      ? response.map(toPersistedLot)
      : response
        ? toPersistedLot(response)
        : null,
    createdAt: receipt.createdAt.toISOString(),
    expiresAt: receipt.expiresAt.toISOString(),
    expiresAtEpochSeconds: Math.floor(receipt.expiresAt.getTime() / 1000),
  };
}

function fromOperationItem(item: PantryOperationItem): PantryOperationReceipt {
  return {
    operationId: item.operationId,
    ownerUserId: item.ownerUserId,
    operation: item.operation,
    requestHash: item.requestHash,
    response: Array.isArray(item.response)
      ? item.response.map(fromPersistedLot)
      : item.response
        ? fromPersistedLot(item.response)
        : null,
    createdAt: new Date(item.createdAt),
    expiresAt: new Date(item.expiresAt),
  };
}

function toPersistedLot(lot: InventoryLotPrimitives): PersistedLot {
  return {
    ...lot,
    expiresAt: lot.expiresAt?.toISOString(),
    purchaseDate: lot.purchaseDate?.toISOString(),
    archivedAt: lot.archivedAt?.toISOString(),
    createdAt: lot.createdAt.toISOString(),
    updatedAt: lot.updatedAt.toISOString(),
  };
}

function fromPersistedLot(lot: PersistedLot): InventoryLotPrimitives {
  return {
    ...lot,
    expiresAt: lot.expiresAt ? new Date(lot.expiresAt) : undefined,
    purchaseDate: lot.purchaseDate ? new Date(lot.purchaseDate) : undefined,
    archivedAt: lot.archivedAt ? new Date(lot.archivedAt) : undefined,
    createdAt: new Date(lot.createdAt),
    updatedAt: new Date(lot.updatedAt),
  };
}

function toInventoryLotItem(
  lot: InventoryLotPrimitives,
): Record<string, unknown> {
  return { entityType: 'INVENTORY_LOT', ...toPersistedLot(lot) };
}

function toWasteEventItem(
  event: WasteEventPrimitives,
): Record<string, unknown> {
  return {
    entityType: 'WASTE_EVENT',
    ...event,
    occurredAt: event.occurredAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.occurredAt.toISOString(),
  };
}

function toProductTypeItem(
  productType: ProductTypePrimitives,
): Record<string, unknown> {
  return {
    entityType: 'PRODUCT_TYPE',
    ...productType,
    normalizedBaseName: productType.baseName.trim().toLocaleLowerCase('es'),
    defaultDepletionRule: productType.defaultDepletionRule
      ? {
          ...productType.defaultDepletionRule,
          anchorDate: productType.defaultDepletionRule.anchorDate.toISOString(),
        }
      : undefined,
    shoppingMetadata: productType.shoppingMetadata
      ? {
          ...productType.shoppingMetadata,
          priceHistory: productType.shoppingMetadata.priceHistory?.map(
            (entry) => ({
              ...entry,
              recordedAt: entry.recordedAt.toISOString(),
            }),
          ),
        }
      : undefined,
    archivedAt: productType.archivedAt?.toISOString(),
    createdAt: productType.createdAt.toISOString(),
    updatedAt: productType.updatedAt.toISOString(),
  };
}

function incrementCheckoutQuota(
  tableName: string,
  ownerUserId: string,
  productTypeIds: string[],
  now: Date,
): TransactionItems[number] {
  const counts = productTypeIds.reduce<Record<string, number>>((result, id) => {
    result[id] = (result[id] ?? 0) + 1;
    return result;
  }, {});
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ':lotDelta': productTypeIds.length,
    ':remainingTotal':
      MAX_ACTIVE_INVENTORY_LOTS_PER_USER - productTypeIds.length,
    ':zero': 0,
    ':updatedAt': now.toISOString(),
  };
  const sets = [
    'activeInventoryLots = activeInventoryLots + :lotDelta',
    'updatedAt = :updatedAt',
  ];
  const conditions = [
    'activeInventoryLots <= :remainingTotal',
    'attribute_not_exists(deleting)',
  ];
  Object.entries(counts).forEach(([id, count], index) => {
    const name = `#productType${index}`;
    const delta = `:typeDelta${index}`;
    const remaining = `:remainingType${index}`;
    names[name] = id;
    values[delta] = count;
    values[remaining] = MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE - count;
    sets.push(
      `lotsByProductType.${name} = if_not_exists(lotsByProductType.${name}, :zero) + ${delta}`,
    );
    conditions.push(
      `(attribute_not_exists(lotsByProductType.${name}) OR lotsByProductType.${name} <= ${remaining})`,
    );
  });
  return {
    Update: {
      TableName: tableName,
      Key: { pk: quotaKey(ownerUserId) },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

function decrementLotQuota(
  tableName: string,
  ownerUserId: string,
  productTypeId: string,
  now: Date,
): TransactionItems[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: quotaKey(ownerUserId) },
      UpdateExpression:
        'SET activeInventoryLots = activeInventoryLots - :delta, lotsByProductType.#productType = lotsByProductType.#productType - :delta, updatedAt = :updatedAt',
      ConditionExpression:
        'activeInventoryLots >= :delta AND lotsByProductType.#productType >= :delta AND attribute_not_exists(deleting)',
      ExpressionAttributeNames: { '#productType': productTypeId },
      ExpressionAttributeValues: {
        ':delta': 1,
        ':updatedAt': now.toISOString(),
      },
    },
  };
}

function incrementSingleLotQuota(
  tableName: string,
  ownerUserId: string,
  productTypeId: string,
  now: Date,
): TransactionItems[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: quotaKey(ownerUserId) },
      UpdateExpression:
        'SET activeInventoryLots = activeInventoryLots + :delta, lotsByProductType.#productType = if_not_exists(lotsByProductType.#productType, :zero) + :delta, updatedAt = :updatedAt',
      ConditionExpression:
        'activeInventoryLots <= :remainingTotal AND (attribute_not_exists(lotsByProductType.#productType) OR lotsByProductType.#productType <= :remainingType) AND attribute_not_exists(deleting)',
      ExpressionAttributeNames: { '#productType': productTypeId },
      ExpressionAttributeValues: {
        ':delta': 1,
        ':zero': 0,
        ':remainingTotal': MAX_ACTIVE_INVENTORY_LOTS_PER_USER - 1,
        ':remainingType': MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE - 1,
        ':updatedAt': now.toISOString(),
      },
    },
  };
}

function incrementSimpleQuota(
  tableName: string,
  ownerUserId: string,
  attribute: 'activeProductTypes' | 'savedShoppingLists',
  maximum: number,
  now: Date,
): TransactionItems[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: quotaKey(ownerUserId) },
      UpdateExpression:
        'SET #counter = #counter + :delta, updatedAt = :updatedAt',
      ConditionExpression:
        '#counter < :maximum AND attribute_not_exists(deleting)',
      ExpressionAttributeNames: { '#counter': attribute },
      ExpressionAttributeValues: {
        ':delta': 1,
        ':maximum': maximum,
        ':updatedAt': now.toISOString(),
      },
    },
  };
}

function productTypeQuota(
  tableName: string,
  productType: ProductType,
  delta: 1 | -1,
): TransactionItems[number] {
  const name = stableRequestHash(
    productType.baseName.trim().toLocaleLowerCase('es'),
  );
  return {
    Update: {
      TableName: tableName,
      Key: { pk: quotaKey(productType.userId.toString()) },
      UpdateExpression:
        delta > 0
          ? 'SET activeProductTypes = activeProductTypes + :delta, productTypeNames.#name = :id, updatedAt = :updatedAt'
          : 'SET activeProductTypes = activeProductTypes + :delta, updatedAt = :updatedAt REMOVE productTypeNames.#name',
      ConditionExpression:
        delta > 0
          ? 'activeProductTypes < :maximum AND attribute_not_exists(productTypeNames.#name) AND attribute_not_exists(deleting)'
          : 'activeProductTypes >= :one AND productTypeNames.#name = :id AND attribute_not_exists(deleting)',
      ExpressionAttributeNames: { '#name': name },
      ExpressionAttributeValues: {
        ':delta': delta,
        ':id': productType.id.toString(),
        ':updatedAt': productType.updatedAt.toISOString(),
        ...(delta > 0
          ? { ':maximum': MAX_ACTIVE_PRODUCT_TYPES_PER_USER }
          : { ':one': 1 }),
      },
    },
  };
}

function decrementSimpleQuota(
  tableName: string,
  ownerUserId: string,
  attribute: 'activeProductTypes' | 'savedShoppingLists',
  now: Date,
): TransactionItems[number] {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: quotaKey(ownerUserId) },
      UpdateExpression:
        'SET #counter = #counter - :delta, updatedAt = :updatedAt',
      ConditionExpression:
        '#counter >= :delta AND attribute_not_exists(deleting)',
      ExpressionAttributeNames: { '#counter': attribute },
      ExpressionAttributeValues: {
        ':delta': 1,
        ':updatedAt': now.toISOString(),
      },
    },
  };
}

function conditionalLotPut(
  tableName: string,
  expected: InventoryLot,
  updated: InventoryLot,
  ownerUserId: string,
): TransactionItems[number] {
  return {
    Put: {
      TableName: tableName,
      Item: toInventoryLotItem(updated.toPrimitives()),
      ConditionExpression:
        'entityType = :entityType AND userId = :owner AND updatedAt = :expectedUpdatedAt AND quantity = :quantity',
      ExpressionAttributeValues: {
        ':entityType': 'INVENTORY_LOT',
        ':owner': ownerUserId,
        ':expectedUpdatedAt': expected.updatedAt.toISOString(),
        ':quantity': expected.quantity,
      },
    },
  };
}

function conditionalProductTypePut(
  tableName: string,
  expected: ProductType,
  updated: ProductType,
  ownerUserId: string,
): TransactionItems[number] {
  return {
    Put: {
      TableName: tableName,
      Item: toProductTypeItem(updated.toPrimitives()),
      ConditionExpression:
        'userId = :owner AND updatedAt = :expectedUpdatedAt AND attribute_not_exists(deleting)',
      ExpressionAttributeValues: {
        ':owner': ownerUserId,
        ':expectedUpdatedAt': expected.updatedAt.toISOString(),
      },
    },
  };
}

function toShoppingListItem(
  list: ShoppingListPrimitives,
): Record<string, unknown> {
  return {
    pk: shoppingListKey(list.id),
    entityType: 'SHOPPING_LIST',
    gsi2pk: `SHOPPING_LIST_OWNER#${list.ownerUserId}`,
    gsi2sk: `UPDATED#${list.updatedAt.toISOString()}#${list.id}`,
    ...list,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  };
}

function toProductItem(product: ProductPrimitives): Record<string, unknown> {
  return {
    entityType: 'PRODUCT',
    ...product,
    nextPurchaseDate: product.nextPurchaseDate?.toISOString(),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}

function toShoppingShareItem(
  share: ShoppingSharePrimitives,
): Record<string, unknown> {
  return {
    pk: `SHOPPING_SHARE#${share.tokenHash}`,
    entityType: 'SHOPPING_SHARE',
    gsi1pk: `SHOPPING_SHARE_BY_ID#${share.id}`,
    gsi1sk: share.tokenHash,
    gsi2pk: `SHOPPING_SHARE_OWNER#${share.ownerUserId}`,
    gsi2sk: `CREATED#${share.createdAt.toISOString()}#${share.id}`,
    ...share,
    createdAt: share.createdAt.toISOString(),
    expiresAt: share.expiresAt.toISOString(),
    revokedAt: share.revokedAt?.toISOString(),
    updatedAt: share.updatedAt.toISOString(),
    expiresAtEpochSeconds: Math.floor(share.expiresAt.getTime() / 1000),
  };
}

function shoppingListKey(id: string): string {
  return `SHOPPING_LIST#${id}`;
}

function operationKey(operationId: string): string {
  return `PANTRY_OPERATION#${operationId}`;
}

function quotaKey(ownerUserId: string): string {
  return `PANTRY_QUOTA#${ownerUserId}`;
}

function quotaAvailable(
  tableName: string,
  ownerUserId: string,
): TransactionItems[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { pk: quotaKey(ownerUserId) },
      ConditionExpression:
        'attribute_exists(pk) AND attribute_not_exists(deleting)',
    },
  };
}

function activeProductTypeCheck(
  tableName: string,
  lot: InventoryLot,
): TransactionItems[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { id: lot.productTypeId.toString() },
      ConditionExpression:
        'userId = :owner AND attribute_not_exists(archivedAt) AND attribute_not_exists(deleting)',
      ExpressionAttributeValues: { ':owner': lot.userId.toString() },
    },
  };
}

function productTypeAvailableCheck(
  tableName: string,
  ownerUserId: string,
  productTypeId: string,
): TransactionItems[number] {
  return {
    ConditionCheck: {
      TableName: tableName,
      Key: { id: productTypeId },
      ConditionExpression: 'userId = :owner AND attribute_not_exists(deleting)',
      ExpressionAttributeValues: { ':owner': ownerUserId },
    },
  };
}

function isTransactionCanceled(
  error: unknown,
): error is Error & { CancellationReasons?: Array<{ Code?: string }> } {
  return (
    error instanceof Error && error.name === 'TransactionCanceledException'
  );
}

function isConditionalCheckFailed(error: unknown): boolean {
  return (
    error instanceof Error && error.name === 'ConditionalCheckFailedException'
  );
}
