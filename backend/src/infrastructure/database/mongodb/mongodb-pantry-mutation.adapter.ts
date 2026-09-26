import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { getArchivedRecordRetentionExpiresAt } from '../../../application/policies/retention-policy';
import { Connection, ClientSession, Model } from 'mongoose';
import {
  CloseShoppingPurchaseMutation,
  ConsumeInventoryLotMutation,
  IdempotencyPayloadConflictError,
  IdempotentMutationResult,
  PantryDeletionReceipt,
  PantryDeletionResult,
  PantryMutationConflictError,
  PantryMutationPort,
  PantryDeletionRequest,
  PantryOperationLookup,
  PantryOperationReceipt,
  PantryQuotaExceededError,
} from '../../../application/ports/pantry-mutation.port';
import {
  MAX_ACTIVE_INVENTORY_LOTS_PER_USER,
  MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
  MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
  MAX_ARCHIVED_PRODUCT_TYPES_PER_USER,
  MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE,
  MAX_SAVED_SHOPPING_LISTS_PER_USER,
} from '../../../application/constants/query-limits';
import { InventoryLotPrimitives } from '../../../domain/entities/inventory-lot.entity';
import { InventoryLot } from '../../../domain/entities/inventory-lot.entity';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { ShoppingList } from '../../../domain/entities/shopping-list.entity';
import { Product } from '../../../domain/entities/product.entity';
import { ShoppingShare } from '../../../domain/entities/shopping-share.entity';
import { InventoryLotDocument } from './schemas/inventory-lot.schema';
import { ProductTypeDocument } from './schemas/product-type.schema';
import { WasteEventDocument } from './schemas/waste-event.schema';

interface MongoPantryOperationDocument {
  _id: string;
  operationId: string;
  ownerUserId: string;
  operation: PantryOperationReceipt['operation'];
  requestHash: string;
  response:
    | InventoryLotPrimitives
    | InventoryLotPrimitives[]
    | PantryDeletionResult
    | null;
  createdAt: Date;
  expiresAt: Date;
}

interface MongoPantryQuotaDocument {
  _id: string;
  ownerUserId: string;
  quotaSchemaVersion: number;
  mutationEpoch: number;
  deleting: boolean;
  activeProductTypes: number;
  archivedProductTypes: number;
  activeInventoryLots: number;
  archivedInventoryLots: number;
  savedShoppingLists: number;
  lotsByProductType: Record<string, number>;
  archivedLotsByProductType: Record<string, number>;
  updatedAt: Date;
  migrationToken?: string;
  mutationVersion?: number;
  expiresAt?: Date;
  deletionToken?: string;
  deletionStartedAt?: Date;
  retainFence?: boolean;
}

const MONGO_PANTRY_QUOTA_SCHEMA_VERSION = 2;
// ponytail: 60s is safely above the production Lambda's 15s timeout; use a durable worker lease if that runtime ceiling changes.
const PANTRY_DELETION_TAKEOVER_MS = 60_000;

@Injectable()
export class MongoPantryMutationAdapter
  implements PantryMutationPort, OnModuleInit
{
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(InventoryLotDocument.name)
    private readonly inventoryLotModel: Model<InventoryLotDocument>,
    @InjectModel(ProductTypeDocument.name)
    private readonly productTypeModel: Model<ProductTypeDocument>,
    @InjectModel(WasteEventDocument.name)
    private readonly wasteEventModel: Model<WasteEventDocument>,
    private readonly configService: ConfigService = new ConfigService(),
  ) {}

  async onModuleInit(): Promise<void> {
    const topology = await this.connection.db!.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid') {
      throw new Error('MongoDB pantry mutations require a replica set');
    }
    await this.productTypeModel.collection.updateMany(
      { archivedAt: { $exists: false }, activeName: { $exists: false } },
      [{ $set: { activeName: '$normalizedBaseName' } }],
    );
    await this.productTypeModel.createIndexes();
    await this.inventoryLotModel.createIndexes();
    await this.wasteEventModel.createIndexes();
    await this.operations.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'pantry_operation_ttl' },
    );
    await this.quotas.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'pantry_deletion_lock_ttl' },
    );
  }

  async findReceipt(
    lookup: PantryOperationLookup,
  ): Promise<PantryOperationReceipt | null> {
    const item = await this.operations.findOne({ _id: lookup.operationId });
    if (!item) {
      return null;
    }
    return this.assertMatchingReceipt(item, lookup);
  }

  async consume(
    mutation: ConsumeInventoryLotMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives | null>> {
    const quotaEpoch = await this.ensureQuota(mutation.receipt.ownerUserId);
    const response = mutation.updatedLot?.toPrimitives() ?? null;

    return this.runIdempotentTransaction(
      mutation.receipt,
      quotaEpoch,
      async (session) => {
        const expected = mutation.expectedLot.toPrimitives();
        const filter = {
          id: expected.id,
          userId: mutation.receipt.ownerUserId,
          updatedAt: expected.updatedAt,
          quantity: expected.quantity,
          archivedAt: { $exists: false },
        };

        await this.assertProductTypeNotDeleting(mutation.expectedLot, session);
        if (mutation.updatedLot) {
          const update = mutation.updatedLot.toPrimitives();
          const result = await this.inventoryLotModel.updateOne(
            filter,
            {
              $set: activeLotDocument(update),
              $unset: {
                archivedAt: 1,
                archivedReason: 1,
                retentionExpiresAt: 1,
              },
            },
            { session },
          );
          if (result.matchedCount !== 1) {
            throw new PantryMutationConflictError();
          }
        } else {
          const result = await this.inventoryLotModel.deleteOne(filter, {
            session,
          });
          if (result.deletedCount !== 1) {
            throw new PantryMutationConflictError();
          }
          const quotaResult = await this.quotas.updateOne(
            {
              _id: mutation.receipt.ownerUserId,
              activeInventoryLots: { $gte: 1 },
              [`lotsByProductType.${expected.productTypeId}`]: { $gte: 1 },
            },
            {
              $inc: {
                activeInventoryLots: -1,
                [`lotsByProductType.${expected.productTypeId}`]: -1,
              },
              $set: { updatedAt: mutation.receipt.createdAt },
            },
            { session },
          );
          if (quotaResult.modifiedCount !== 1) {
            throw new PantryMutationConflictError(
              'Pantry quota is inconsistent',
            );
          }
        }

        if (mutation.wasteEvent) {
          await this.wasteEventModel.create(
            [mutation.wasteEvent.toPrimitives()],
            { session },
          );
        }
        return response;
      },
    );
  }

  async checkout(
    mutation: CloseShoppingPurchaseMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives[]>> {
    const quotaEpoch = await this.ensureQuota(mutation.receipt.ownerUserId);
    const response = mutation.lots.map((lot) => lot.toPrimitives());

    return this.runIdempotentTransaction(
      mutation.receipt,
      quotaEpoch,
      async (session) => {
        for (const change of mutation.productTypes) {
          const expected = change.expected.toPrimitives();
          const filter = {
            id: expected.id,
            userId: mutation.receipt.ownerUserId,
            updatedAt: expected.updatedAt,
            archivedAt: { $exists: false },
            deleting: { $ne: true },
          };
          if (change.changed) {
            const updated = change.updated.toPrimitives();
            const result = await this.productTypeModel.updateOne(
              filter,
              {
                $set: {
                  ...updated,
                  normalizedBaseName: updated.baseName
                    .trim()
                    .toLocaleLowerCase('es'),
                },
                $unset: {
                  archivedAt: 1,
                  archivedReason: 1,
                  retentionExpiresAt: 1,
                },
              },
              { session },
            );
            if (result.matchedCount !== 1) {
              throw new PantryMutationConflictError();
            }
          } else if (
            !(await this.productTypeModel.exists(filter).session(session))
          ) {
            throw new PantryMutationConflictError();
          }
        }

        await this.inventoryLotModel.insertMany(
          mutation.lots.map((lot) => activeLotDocument(lot.toPrimitives())),
          { session, ordered: true },
        );
        const quotaUpdate = checkoutQuotaUpdate(
          mutation.receipt.ownerUserId,
          mutation.lots.map((lot) => lot.productTypeId.toString()),
          mutation.receipt.createdAt,
        );
        const quotaResult = await this.quotas.updateOne(
          quotaUpdate.filter,
          quotaUpdate.update,
          { session },
        );
        if (quotaResult.modifiedCount !== 1) {
          throw new PantryQuotaExceededError(
            'Pantry inventory lot quota exceeded',
          );
        }
        return response;
      },
    );
  }

  async createInventoryLot(lot: InventoryLot): Promise<InventoryLot> {
    const ownerUserId = lot.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.assertActiveProductType(lot, session);
      await this.inventoryLotModel.create(
        [activeLotDocument(lot.toPrimitives())],
        { session },
      );
      const update = checkoutQuotaUpdate(
        lot.userId.toString(),
        [lot.productTypeId.toString()],
        lot.updatedAt,
      );
      const result = await this.quotas.updateOne(update.filter, update.update, {
        session,
      });
      if (result.modifiedCount !== 1) {
        throw new PantryQuotaExceededError(
          'Pantry inventory lot quota exceeded',
        );
      }
      return lot;
    });
  }

  async archiveInventoryLot(
    expected: InventoryLot,
    archived: InventoryLot,
  ): Promise<InventoryLot> {
    const ownerUserId = expected.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.assertProductTypeNotDeleting(expected, session);
      const result = await this.inventoryLotModel.updateOne(
        {
          id: expected.id.toString(),
          userId: expected.userId.toString(),
          updatedAt: expected.updatedAt,
        },
        {
          $set: {
            ...archived.toPrimitives(),
            retentionExpiresAt: getArchivedRecordRetentionExpiresAt(
              archived.archivedAt,
              this.configService,
            ),
          },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new PantryMutationConflictError();
      }
      if (!expected.archivedAt && archived.archivedAt) {
        await this.archiveMongoLotQuota(expected, archived.updatedAt, session);
      }
      return archived;
    });
  }

  async restoreInventoryLot(
    expected: InventoryLot,
    restored: InventoryLot,
  ): Promise<InventoryLot> {
    const ownerUserId = expected.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.assertActiveProductType(restored, session);
      const result = await this.inventoryLotModel.updateOne(
        {
          id: expected.id.toString(),
          userId: expected.userId.toString(),
          updatedAt: expected.updatedAt,
        },
        {
          $set: activeLotDocument(restored.toPrimitives()),
          $unset: { archivedAt: 1, archivedReason: 1, retentionExpiresAt: 1 },
        },
        { session },
      );
      if (result.matchedCount !== 1) {
        throw new PantryMutationConflictError();
      }
      if (expected.archivedAt && !restored.archivedAt) {
        await this.restoreMongoLotQuota(expected, restored.updatedAt, session);
      }
      return restored;
    });
  }

  async createProductType(productType: ProductType): Promise<ProductType> {
    const ownerUserId = productType.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      const primitives = productType.toPrimitives();
      await this.productTypeModel.create(
        [
          {
            ...primitives,
            normalizedBaseName: primitives.baseName
              .trim()
              .toLocaleLowerCase('es'),
            activeName: primitives.baseName.trim().toLocaleLowerCase('es'),
          },
        ],
        { session },
      );
      await this.incrementMongoSimpleQuota(
        productType.userId.toString(),
        'activeProductTypes',
        MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
        productType.updatedAt,
        session,
      );
      return productType;
    });
  }

  async archiveProductType(
    expected: ProductType,
    archived: ProductType,
  ): Promise<ProductType> {
    const ownerUserId = expected.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.replaceMongoProductType(expected, archived, session);
      if (!expected.archivedAt && archived.archivedAt) {
        await this.archiveMongoProductTypeQuota(
          expected,
          archived.updatedAt,
          session,
        );
      }
      return archived;
    });
  }

  async restoreProductType(
    expected: ProductType,
    restored: ProductType,
  ): Promise<ProductType> {
    const ownerUserId = expected.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.replaceMongoProductType(expected, restored, session);
      if (expected.archivedAt && !restored.archivedAt) {
        await this.restoreMongoProductTypeQuota(
          expected,
          restored.updatedAt,
          session,
        );
      }
      return restored;
    });
  }

  async createShoppingList(list: ShoppingList): Promise<ShoppingList> {
    const quotaEpoch = await this.ensureQuota(list.ownerUserId);
    return this.runAtomicMutation(
      list.ownerUserId,
      quotaEpoch,
      async (session) => {
        await this.connection
          .collection('shoppingLists')
          .insertOne(list.toPrimitives(), { session });
        await this.incrementMongoSimpleQuota(
          list.ownerUserId,
          'savedShoppingLists',
          MAX_SAVED_SHOPPING_LISTS_PER_USER,
          list.toPrimitives().updatedAt,
          session,
        );
        return list;
      },
    );
  }

  async createProduct(product: Product): Promise<Product> {
    const ownerUserId = product.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.connection
        .collection('products')
        .insertOne(product.toPrimitives(), { session });
      return product;
    });
  }

  async updateProduct(expected: Product, updated: Product): Promise<Product> {
    const ownerUserId = expected.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      const result = await this.connection.collection('products').updateOne(
        {
          id: expected.id.toString(),
          userId: ownerUserId,
          updatedAt: expected.updatedAt,
        },
        { $set: updated.toPrimitives() },
        { session },
      );
      if (result.matchedCount !== 1) throw new PantryMutationConflictError();
      return updated;
    });
  }

  async createShoppingShare(share: ShoppingShare): Promise<ShoppingShare> {
    const ownerUserId = share.ownerUserId;
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.connection
        .collection('shoppingShares')
        .insertOne(share.toPrimitives(), { session });
      return share;
    });
  }

  async updateShoppingShare(
    expected: ShoppingShare,
    updated: ShoppingShare,
  ): Promise<ShoppingShare> {
    const expectedPrimitives = expected.toPrimitives();
    const quotaEpoch = await this.ensureQuota(expected.ownerUserId);
    return this.runAtomicMutation(
      expected.ownerUserId,
      quotaEpoch,
      async (session) => {
        const result = await this.connection
          .collection('shoppingShares')
          .updateOne(
            {
              id: expectedPrimitives.id,
              ownerUserId: expected.ownerUserId,
              updatedAt: expectedPrimitives.updatedAt,
            },
            { $set: updated.toPrimitives() },
            { session },
          );
        if (result.matchedCount !== 1) throw new PantryMutationConflictError();
        return updated;
      },
    );
  }

  async deleteShoppingList(list: ShoppingList): Promise<void> {
    const quotaEpoch = await this.ensureQuota(list.ownerUserId);
    await this.runAtomicMutation(
      list.ownerUserId,
      quotaEpoch,
      async (session) => {
        const result = await this.connection
          .collection('shoppingLists')
          .deleteOne(
            { id: list.id, ownerUserId: list.ownerUserId },
            { session },
          );
        if (result.deletedCount !== 1) {
          throw new PantryMutationConflictError();
        }
        await this.decrementMongoSimpleQuota(
          list.ownerUserId,
          'savedShoppingLists',
          list.toPrimitives().updatedAt,
          session,
        );
      },
    );
  }

  async deleteInventoryLot(lot: InventoryLot): Promise<void> {
    const ownerUserId = lot.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    await this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      const result = await this.inventoryLotModel.deleteOne(
        {
          id: lot.id.toString(),
          userId: lot.userId.toString(),
          updatedAt: lot.updatedAt,
          quantity: lot.quantity,
        },
        { session },
      );
      if (result.deletedCount !== 1) throw new PantryMutationConflictError();
      if (lot.archivedAt) {
        await this.decrementMongoArchivedLotQuota(lot, new Date(), session);
      } else {
        await this.decrementMongoLotQuota(lot, new Date(), session);
      }
    });
  }

  async deleteProductType(productType: ProductType): Promise<void> {
    const ownerUserId = productType.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    await this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      if (
        await this.inventoryLotModel
          .exists({
            productTypeId: productType.id.toString(),
            userId: productType.userId.toString(),
          })
          .session(session)
      ) {
        throw new PantryMutationConflictError(
          'Product type still has inventory',
        );
      }
      const result = await this.productTypeModel.deleteOne(
        {
          id: productType.id.toString(),
          userId: productType.userId.toString(),
          updatedAt: productType.updatedAt,
          archivedAt: { $exists: true },
          deleting: true,
        },
        { session },
      );
      if (result.deletedCount !== 1) throw new PantryMutationConflictError();
      await this.decrementMongoArchivedProductTypeQuota(
        productType,
        new Date(),
        session,
      );
    });
  }

  async beginProductTypeDeletion(productType: ProductType): Promise<void> {
    const ownerUserId = productType.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    await this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      const result = await this.productTypeModel.updateOne(
        {
          id: productType.id.toString(),
          userId: ownerUserId,
          updatedAt: productType.updatedAt,
          archivedAt: { $exists: true },
        },
        {
          $set: { deleting: true },
          $unset: { retentionExpiresAt: 1 },
        },
        { session },
      );
      if (result.matchedCount !== 1) throw new PantryMutationConflictError();
    });
  }

  async updateProductType(
    expected: ProductType,
    updated: ProductType,
  ): Promise<ProductType> {
    const ownerUserId = expected.userId.toString();
    const quotaEpoch = await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(ownerUserId, quotaEpoch, async (session) => {
      await this.replaceMongoProductType(expected, updated, session);
      return updated;
    });
  }

  async beginPantryDeletion(
    ownerUserId: string,
    request: PantryDeletionRequest = {},
  ): Promise<string> {
    const deletionToken = request.deletionToken ?? randomUUID();
    const retainFence = request.retainFence === true;
    const deletionStartedAt = new Date();
    const existing = await this.quotas.findOne({ _id: ownerUserId });
    if (existing?.deleting && !existing.migrationToken) {
      if (
        retainFence &&
        existing.quotaSchemaVersion === MONGO_PANTRY_QUOTA_SCHEMA_VERSION &&
        typeof existing.mutationEpoch === 'number' &&
        existing.deletionToken === deletionToken &&
        existing.retainFence === retainFence
      ) {
        return deletionToken;
      }
      if (
        existing.retainFence === false &&
        typeof existing.mutationEpoch === 'number' &&
        existing.deletionStartedAt instanceof Date &&
        existing.deletionStartedAt.getTime() <
          Date.now() - PANTRY_DELETION_TAKEOVER_MS
      ) {
        const takeover = await this.quotas.updateOne(
          {
            _id: ownerUserId,
            quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
            mutationEpoch: existing.mutationEpoch,
            deleting: true,
            deletionToken: existing.deletionToken,
            deletionStartedAt: existing.deletionStartedAt,
            retainFence: false,
          },
          {
            $set: {
              mutationEpoch: existing.mutationEpoch + 1,
              deletionToken,
              deletionStartedAt,
              retainFence,
            },
          },
        );
        if (takeover.matchedCount === 1) return deletionToken;
      }
      throw new PantryMutationConflictError('Pantry is already being deleted');
    }
    const mutationEpoch = await this.ensureQuota(ownerUserId);
    const result = await this.quotas.updateOne(
      {
        _id: ownerUserId,
        quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
        mutationEpoch,
        deleting: false,
      },
      {
        $set: {
          deleting: true,
          mutationEpoch: mutationEpoch + 1,
          deletionToken,
          deletionStartedAt,
          retainFence,
        },
        $unset: { expiresAt: 1 },
      },
    );
    if (result.matchedCount === 1) return deletionToken;
    const current = await this.quotas.findOne({ _id: ownerUserId });
    if (
      current?.deleting &&
      !current.migrationToken &&
      current.quotaSchemaVersion === MONGO_PANTRY_QUOTA_SCHEMA_VERSION &&
      typeof current.mutationEpoch === 'number' &&
      current.deletionToken === deletionToken &&
      retainFence &&
      current.retainFence === retainFence
    ) {
      return deletionToken;
    }
    throw new PantryMutationConflictError('Pantry is already being deleted');
  }

  async completePantryDeletion(
    ownerUserId: string,
    deletionToken: string,
    retainFence = false,
    receipt?: PantryDeletionReceipt,
  ): Promise<void> {
    const fence = await this.quotas.findOne({ _id: ownerUserId });
    if (
      fence?.quotaSchemaVersion !== MONGO_PANTRY_QUOTA_SCHEMA_VERSION ||
      fence.deleting !== true ||
      typeof fence.mutationEpoch !== 'number' ||
      fence.deletionToken !== deletionToken ||
      fence.retainFence !== retainFence ||
      (receipt !== undefined &&
        (retainFence ||
          receipt.ownerUserId !== ownerUserId ||
          receipt.operationId !== deletionToken))
    ) {
      throw new PantryMutationConflictError('Pantry deletion fence is missing');
    }
    const mutationEpoch = fence.mutationEpoch;
    await this.operations.deleteMany(
      retainFence
        ? { ownerUserId }
        : { ownerUserId, operation: { $ne: 'delete_pantry_data' } },
    );
    if (retainFence) {
      const result = await this.connection
        .collection<{
          _id: string;
          ownerUserId: string;
          quotaSchemaVersion: number;
          mutationEpoch: number;
          deleting: boolean;
          deletionToken: string;
          deletionStartedAt: Date;
          retainFence: boolean;
        }>('pantry_quotas')
        .replaceOne(
          {
            _id: ownerUserId,
            quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
            mutationEpoch,
            deleting: true,
            deletionToken,
            deletionStartedAt: fence.deletionStartedAt,
            retainFence: true,
          },
          {
            ownerUserId,
            quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
            mutationEpoch,
            deleting: true,
            deletionToken,
            deletionStartedAt: fence.deletionStartedAt!,
            retainFence: true,
          },
        );
      if (result.matchedCount !== 1) {
        throw new PantryMutationConflictError(
          'Pantry deletion fence changed during cleanup',
        );
      }
      return;
    }
    const filter = {
      _id: ownerUserId,
      quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
      mutationEpoch,
      deleting: true,
      deletionToken,
      retainFence: false,
    };
    const replacement = {
      ownerUserId,
      quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
      mutationEpoch,
      deleting: false,
      activeProductTypes: 0,
      archivedProductTypes: 0,
      activeInventoryLots: 0,
      archivedInventoryLots: 0,
      savedShoppingLists: 0,
      lotsByProductType: {},
      archivedLotsByProductType: {},
      updatedAt: new Date(),
    };
    if (!receipt) {
      const result = await this.quotas.replaceOne(filter, replacement);
      if (result.matchedCount !== 1) {
        throw new PantryMutationConflictError(
          'Pantry deletion fence changed during cleanup',
        );
      }
      return;
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const result = await this.quotas.replaceOne(filter, replacement, {
          session,
        });
        if (result.matchedCount !== 1) {
          throw new PantryMutationConflictError(
            'Pantry deletion fence changed during cleanup',
          );
        }
        await this.operations.insertOne(
          {
            _id: receipt.operationId,
            operationId: receipt.operationId,
            ownerUserId: receipt.ownerUserId,
            operation: receipt.operation,
            requestHash: receipt.requestHash,
            response: receipt.response,
            createdAt: receipt.createdAt,
            expiresAt: receipt.expiresAt,
          },
          { session, ignoreUndefined: true },
        );
      });
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        throw new PantryMutationConflictError(
          'MongoDB pantry mutations require a replica set',
        );
      }
      if (isDuplicateKey(error)) {
        throw new PantryMutationConflictError(
          'Pantry deletion receipt already exists',
        );
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async abortPantryDeletion(
    ownerUserId: string,
    deletionToken: string,
  ): Promise<void> {
    const fence = await this.quotas.findOne({ _id: ownerUserId });
    if (
      fence?.quotaSchemaVersion !== MONGO_PANTRY_QUOTA_SCHEMA_VERSION ||
      fence.deleting !== true ||
      fence.retainFence !== false ||
      fence.deletionToken !== deletionToken ||
      typeof fence.mutationEpoch !== 'number'
    ) {
      throw new PantryMutationConflictError('Pantry deletion fence is missing');
    }

    const quota = await this.buildQuota(ownerUserId);
    const result = await this.quotas.replaceOne(
      {
        _id: ownerUserId,
        quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
        mutationEpoch: fence.mutationEpoch,
        deleting: true,
        deletionToken,
        retainFence: false,
      },
      {
        ...quota,
        mutationEpoch: fence.mutationEpoch,
      },
    );
    if (result.matchedCount !== 1) {
      throw new PantryMutationConflictError(
        'Pantry deletion fence changed during recovery',
      );
    }
  }

  private async assertPantryAvailable(
    ownerUserId: string,
    mutationEpoch: number,
    session: ClientSession,
  ): Promise<void> {
    // Writing the owner row serializes deletion against otherwise counter-neutral mutations.
    const result = await this.quotas.updateOne(
      {
        _id: ownerUserId,
        quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
        mutationEpoch,
        deleting: false,
      },
      { $inc: { mutationVersion: 1 } },
      { session },
    );
    if (result.matchedCount !== 1)
      throw new PantryMutationConflictError('Pantry is being deleted');
  }

  private async assertActiveProductType(
    lot: InventoryLot,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.productTypeModel.updateOne(
      {
        id: lot.productTypeId.toString(),
        userId: lot.userId.toString(),
        archivedAt: { $exists: false },
        deleting: { $ne: true },
      },
      { $inc: { mutationVersion: 1 } },
      { session, strict: false },
    );
    if (result.matchedCount !== 1)
      throw new PantryMutationConflictError('Product type is no longer active');
  }

  private async assertProductTypeNotDeleting(
    lot: InventoryLot,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.productTypeModel.updateOne(
      {
        id: lot.productTypeId.toString(),
        userId: lot.userId.toString(),
        deleting: { $ne: true },
      },
      { $inc: { mutationVersion: 1 } },
      { session, strict: false },
    );
    if (result.matchedCount !== 1) {
      throw new PantryMutationConflictError('Product type is being deleted');
    }
  }

  private async runAtomicMutation<T>(
    ownerUserId: string,
    mutationEpoch: number,
    mutation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    let value: T | undefined;
    let committed = false;
    try {
      await session.withTransaction(async () => {
        await this.assertPantryAvailable(ownerUserId, mutationEpoch, session);
        value = await mutation(session);
        committed = true;
      });
    } catch (error) {
      if (isTransactionUnsupported(error)) {
        throw new PantryMutationConflictError(
          'MongoDB pantry mutations require a replica set',
        );
      }
      if (isDuplicateKey(error)) {
        throw new PantryMutationConflictError();
      }
      throw error;
    } finally {
      await session.endSession();
    }
    if (!committed) {
      throw new PantryMutationConflictError(
        'MongoDB transaction did not commit',
      );
    }
    return value as T;
  }

  private async decrementMongoLotQuota(
    lot: InventoryLot,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.quotas.updateOne(
      {
        _id: lot.userId.toString(),
        deleting: false,
        activeInventoryLots: { $gte: 1 },
        [`lotsByProductType.${lot.productTypeId.toString()}`]: { $gte: 1 },
      },
      {
        $inc: {
          activeInventoryLots: -1,
          [`lotsByProductType.${lot.productTypeId.toString()}`]: -1,
        },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryMutationConflictError('Pantry quota is inconsistent');
    }
  }

  private async archiveMongoLotQuota(
    lot: InventoryLot,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const productTypePath = lot.productTypeId.toString();
    const result = await this.quotas.updateOne(
      {
        _id: lot.userId.toString(),
        deleting: false,
        activeInventoryLots: { $gte: 1 },
        archivedInventoryLots: {
          $lt: MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
        },
        [`lotsByProductType.${productTypePath}`]: { $gte: 1 },
      },
      {
        $inc: {
          activeInventoryLots: -1,
          archivedInventoryLots: 1,
          [`lotsByProductType.${productTypePath}`]: -1,
          [`archivedLotsByProductType.${productTypePath}`]: 1,
        },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryQuotaExceededError(
        'Archived inventory lot quota exceeded',
      );
    }
  }

  private async restoreMongoLotQuota(
    lot: InventoryLot,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const productTypePath = lot.productTypeId.toString();
    const result = await this.quotas.updateOne(
      {
        _id: lot.userId.toString(),
        deleting: false,
        archivedInventoryLots: { $gte: 1 },
        activeInventoryLots: {
          $lte: MAX_ACTIVE_INVENTORY_LOTS_PER_USER - 1,
        },
        [`archivedLotsByProductType.${productTypePath}`]: { $gte: 1 },
        $or: [
          { [`lotsByProductType.${productTypePath}`]: { $exists: false } },
          {
            [`lotsByProductType.${productTypePath}`]: {
              $lte: MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE - 1,
            },
          },
        ],
      },
      {
        $inc: {
          activeInventoryLots: 1,
          archivedInventoryLots: -1,
          [`lotsByProductType.${productTypePath}`]: 1,
          [`archivedLotsByProductType.${productTypePath}`]: -1,
        },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryQuotaExceededError('Pantry inventory lot quota exceeded');
    }
  }

  private async decrementMongoArchivedLotQuota(
    lot: InventoryLot,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const productTypePath = lot.productTypeId.toString();
    const result = await this.quotas.updateOne(
      {
        _id: lot.userId.toString(),
        deleting: false,
        archivedInventoryLots: { $gte: 1 },
        [`archivedLotsByProductType.${productTypePath}`]: { $gte: 1 },
      },
      {
        $inc: {
          archivedInventoryLots: -1,
          [`archivedLotsByProductType.${productTypePath}`]: -1,
        },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryMutationConflictError('Pantry quota is inconsistent');
    }
  }

  private async archiveMongoProductTypeQuota(
    productType: ProductType,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.quotas.updateOne(
      {
        _id: productType.userId.toString(),
        deleting: false,
        activeProductTypes: { $gte: 1 },
        archivedProductTypes: { $lt: MAX_ARCHIVED_PRODUCT_TYPES_PER_USER },
      },
      {
        $inc: { activeProductTypes: -1, archivedProductTypes: 1 },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryQuotaExceededError(
        'Archived product type quota exceeded',
      );
    }
  }

  private async restoreMongoProductTypeQuota(
    productType: ProductType,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.quotas.updateOne(
      {
        _id: productType.userId.toString(),
        deleting: false,
        archivedProductTypes: { $gte: 1 },
        activeProductTypes: { $lt: MAX_ACTIVE_PRODUCT_TYPES_PER_USER },
      },
      {
        $inc: { activeProductTypes: 1, archivedProductTypes: -1 },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryQuotaExceededError('activeProductTypes quota exceeded');
    }
  }

  private async decrementMongoArchivedProductTypeQuota(
    productType: ProductType,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const typePath = productType.id.toString();
    const result = await this.quotas.updateOne(
      {
        _id: productType.userId.toString(),
        deleting: false,
        archivedProductTypes: { $gte: 1 },
        $and: [
          {
            $or: [
              { [`lotsByProductType.${typePath}`]: { $exists: false } },
              { [`lotsByProductType.${typePath}`]: 0 },
            ],
          },
          {
            $or: [
              {
                [`archivedLotsByProductType.${typePath}`]: { $exists: false },
              },
              { [`archivedLotsByProductType.${typePath}`]: 0 },
            ],
          },
        ],
      },
      {
        $inc: { archivedProductTypes: -1 },
        $set: { updatedAt: now },
      },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryMutationConflictError('Pantry quota is inconsistent');
    }
  }

  private async incrementMongoSimpleQuota(
    ownerUserId: string,
    counter: 'activeProductTypes' | 'savedShoppingLists',
    maximum: number,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.quotas.updateOne(
      {
        _id: ownerUserId,
        deleting: false,
        [counter]: { $lt: maximum },
      },
      { $inc: { [counter]: 1 }, $set: { updatedAt: now } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryQuotaExceededError(`${counter} quota exceeded`);
    }
  }

  private async decrementMongoSimpleQuota(
    ownerUserId: string,
    counter: 'activeProductTypes' | 'savedShoppingLists',
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.quotas.updateOne(
      {
        _id: ownerUserId,
        deleting: false,
        [counter]: { $gte: 1 },
      },
      { $inc: { [counter]: -1 }, $set: { updatedAt: now } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new PantryMutationConflictError('Pantry quota is inconsistent');
    }
  }

  private async replaceMongoProductType(
    expected: ProductType,
    updated: ProductType,
    session: ClientSession,
  ): Promise<void> {
    const primitives = updated.toPrimitives();
    const retentionExpiresAt = getArchivedRecordRetentionExpiresAt(
      primitives.archivedAt,
      this.configService,
    );
    const unset: Record<string, 1> = {};
    if (!retentionExpiresAt) unset.retentionExpiresAt = 1;
    if (!primitives.archivedAt) {
      unset.archivedAt = 1;
      unset.archivedReason = 1;
      unset.retentionExpiresAt = 1;
    } else {
      unset.activeName = 1;
    }
    const result = await this.productTypeModel.updateOne(
      {
        id: expected.id.toString(),
        userId: expected.userId.toString(),
        updatedAt: expected.updatedAt,
        deleting: { $ne: true },
      },
      {
        $set: {
          ...primitives,
          ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
          normalizedBaseName: primitives.baseName
            .trim()
            .toLocaleLowerCase('es'),
          ...(!primitives.archivedAt
            ? { activeName: primitives.baseName.trim().toLocaleLowerCase('es') }
            : {}),
        },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new PantryMutationConflictError();
    }
  }

  private async runIdempotentTransaction<
    T extends InventoryLotPrimitives | InventoryLotPrimitives[] | null,
  >(
    receipt: PantryOperationLookup,
    mutationEpoch: number,
    mutation: (session: ClientSession) => Promise<T>,
  ): Promise<IdempotentMutationResult<T>> {
    const session = await this.connection.startSession();
    let value: T | undefined;
    let replayed = false;

    try {
      await session.withTransaction(async () => {
        const existing = await this.operations.findOne(
          { _id: receipt.operationId },
          { session },
        );
        if (existing) {
          value = this.assertMatchingReceipt(existing, receipt).response as T;
          replayed = true;
          return;
        }

        await this.assertPantryAvailable(
          receipt.ownerUserId,
          mutationEpoch,
          session,
        );
        value = await mutation(session);
        await this.operations.insertOne(
          {
            _id: receipt.operationId,
            operationId: receipt.operationId,
            ownerUserId: receipt.ownerUserId,
            operation: receipt.operation,
            requestHash: receipt.requestHash,
            response: value,
            createdAt: receipt.createdAt,
            expiresAt: receipt.expiresAt,
          },
          { session, ignoreUndefined: true },
        );
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        const existing = await this.findReceipt(receipt);
        if (existing) {
          return { value: existing.response as T, replayed: true };
        }
        throw new PantryMutationConflictError(
          'Idempotency-Key expired or is ambiguous; inspect inventory before starting a new operation',
        );
      }
      if (isTransactionUnsupported(error)) {
        throw new PantryMutationConflictError(
          'MongoDB pantry mutations require a replica set',
        );
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (value === undefined) {
      throw new PantryMutationConflictError(
        'MongoDB transaction did not commit',
      );
    }
    return { value, replayed };
  }

  private assertMatchingReceipt(
    item: MongoPantryOperationDocument,
    lookup: PantryOperationLookup,
  ): PantryOperationReceipt {
    if (
      item.ownerUserId !== lookup.ownerUserId ||
      item.operation !== lookup.operation ||
      item.requestHash !== lookup.requestHash
    ) {
      throw new IdempotencyPayloadConflictError();
    }
    if (!(new Date(item.expiresAt).getTime() > Date.now())) {
      throw new PantryMutationConflictError(
        'Idempotency-Key has expired; inspect inventory before starting a new operation',
      );
    }
    return {
      operationId: item.operationId,
      ownerUserId: item.ownerUserId,
      operation: item.operation,
      requestHash: item.requestHash,
      response: item.response,
      createdAt: new Date(item.createdAt),
      expiresAt: new Date(item.expiresAt),
    };
  }

  private async ensureQuota(ownerUserId: string): Promise<number> {
    const existing = await this.quotas.findOne({ _id: ownerUserId });
    if (isCurrentMongoQuota(existing)) return existing!.mutationEpoch;
    if (existing?.deleting && !existing.migrationToken) {
      throw new PantryMutationConflictError('Pantry is being deleted');
    }
    return this.migrateQuota(ownerUserId);
  }

  private async migrateQuota(ownerUserId: string): Promise<number> {
    let migrationToken: string | undefined;
    for (let attempt = 0; attempt < 3 && !migrationToken; attempt += 1) {
      const current = await this.quotas.findOne({ _id: ownerUserId });
      if (isCurrentMongoQuota(current)) return current!.mutationEpoch;
      if (current?.deleting) {
        if (current.migrationToken) {
          migrationToken = current.migrationToken;
          break;
        }
        throw new PantryMutationConflictError('Pantry is being deleted');
      }

      const candidate = randomUUID();
      try {
        if (current) {
          const result = await this.quotas.updateOne(
            {
              _id: ownerUserId,
              migrationToken: { $exists: false },
              $or: [{ deleting: { $exists: false } }, { deleting: false }],
            },
            { $set: { deleting: true, migrationToken: candidate } },
          );
          if (result.matchedCount === 1) migrationToken = candidate;
        } else {
          await this.quotas.insertOne({
            _id: ownerUserId,
            ownerUserId,
            deleting: true,
            migrationToken: candidate,
          } as MongoPantryQuotaDocument);
          migrationToken = candidate;
        }
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    if (!migrationToken) {
      throw new PantryMutationConflictError(
        'Pantry quota migration is already running; retry the mutation',
      );
    }

    const quota = await this.buildQuota(ownerUserId);
    const result = await this.quotas.replaceOne(
      { _id: ownerUserId, deleting: true, migrationToken },
      quota,
    );
    if (result.matchedCount === 1) return quota.mutationEpoch;

    const current = await this.quotas.findOne({ _id: ownerUserId });
    if (isCurrentMongoQuota(current)) return current!.mutationEpoch;
    throw new PantryMutationConflictError(
      'Pantry quota migration changed; retry the mutation',
    );
  }

  private async buildQuota(
    ownerUserId: string,
  ): Promise<Omit<MongoPantryQuotaDocument, '_id'>> {
    const [lots, productTypes, savedShoppingLists] = await Promise.all([
      this.inventoryLotModel
        .find({ userId: ownerUserId })
        .select({ productTypeId: 1, archivedAt: 1, _id: 0 })
        .lean(),
      this.productTypeModel
        .find({ userId: ownerUserId })
        .select({ archivedAt: 1, _id: 0 })
        .lean(),
      this.connection
        .collection('shoppingLists')
        .countDocuments({ ownerUserId }),
    ]);
    const activeLots = lots.filter((lot) => !lot.archivedAt);
    const archivedLots = lots.filter((lot) => Boolean(lot.archivedAt));
    const lotsByProductType = activeLots.reduce<Record<string, number>>(
      (counts, lot) => {
        counts[lot.productTypeId] = (counts[lot.productTypeId] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const archivedLotsByProductType = archivedLots.reduce<
      Record<string, number>
    >((counts, lot) => {
      counts[lot.productTypeId] = (counts[lot.productTypeId] ?? 0) + 1;
      return counts;
    }, {});
    const activeProductTypes = productTypes.filter(
      (productType) => !productType.archivedAt,
    ).length;
    const archivedProductTypes = productTypes.length - activeProductTypes;
    return {
      ownerUserId,
      quotaSchemaVersion: MONGO_PANTRY_QUOTA_SCHEMA_VERSION,
      mutationEpoch: 0,
      deleting: false,
      activeProductTypes,
      archivedProductTypes,
      activeInventoryLots: activeLots.length,
      archivedInventoryLots: archivedLots.length,
      savedShoppingLists,
      lotsByProductType,
      archivedLotsByProductType,
      updatedAt: new Date(),
    };
  }

  private get operations() {
    return this.connection.collection<MongoPantryOperationDocument>(
      'pantry_operations',
    );
  }

  private get quotas() {
    return this.connection.collection<MongoPantryQuotaDocument>(
      'pantry_quotas',
    );
  }
}

function isCurrentMongoQuota(quota: MongoPantryQuotaDocument | null): boolean {
  return Boolean(
    quota &&
    quota.quotaSchemaVersion === MONGO_PANTRY_QUOTA_SCHEMA_VERSION &&
    quota.deleting === false &&
    typeof quota.mutationEpoch === 'number' &&
    typeof quota.activeProductTypes === 'number' &&
    typeof quota.archivedProductTypes === 'number' &&
    typeof quota.activeInventoryLots === 'number' &&
    typeof quota.archivedInventoryLots === 'number' &&
    typeof quota.savedShoppingLists === 'number' &&
    isCounterMap(quota.lotsByProductType) &&
    isCounterMap(quota.archivedLotsByProductType) &&
    !quota.migrationToken,
  );
}

function isCounterMap(value: unknown): value is Record<string, number> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function activeLotDocument(
  lot: InventoryLotPrimitives,
): Record<string, unknown> {
  return {
    id: lot.id,
    userId: lot.userId,
    productTypeId: lot.productTypeId,
    variantName: lot.variantName,
    quantity: lot.quantity,
    unit: lot.unit,
    expiresAt: lot.expiresAt,
    purchaseDate: lot.purchaseDate,
    createdAt: lot.createdAt,
    updatedAt: lot.updatedAt,
  };
}

function checkoutQuotaUpdate(
  ownerUserId: string,
  productTypeIds: string[],
  now: Date,
): {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
} {
  const counts = productTypeIds.reduce<Record<string, number>>((result, id) => {
    result[id] = (result[id] ?? 0) + 1;
    return result;
  }, {});
  const and = Object.entries(counts).map(([id, count]) => ({
    $or: [
      { [`lotsByProductType.${id}`]: { $exists: false } },
      {
        [`lotsByProductType.${id}`]: {
          $lte: MAX_INVENTORY_LOTS_PER_PRODUCT_TYPE - count,
        },
      },
    ],
  }));
  const increments: Record<string, number> = {
    activeInventoryLots: productTypeIds.length,
  };
  Object.entries(counts).forEach(([id, count]) => {
    increments[`lotsByProductType.${id}`] = count;
  });
  return {
    filter: {
      _id: ownerUserId,
      deleting: false,
      activeInventoryLots: {
        $lte: MAX_ACTIVE_INVENTORY_LOTS_PER_USER - productTypeIds.length,
      },
      ...(and.length ? { $and: and } : {}),
    },
    update: { $inc: increments, $set: { updatedAt: now } },
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function isTransactionUnsupported(error: unknown): boolean {
  return (
    error instanceof Error &&
    /transaction numbers are only allowed|replica set/i.test(error.message)
  );
}
