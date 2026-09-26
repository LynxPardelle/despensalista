import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getArchivedRecordRetentionExpiresAt } from '../../../application/policies/retention-policy';
import { Connection, ClientSession, Model } from 'mongoose';
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
  response: InventoryLotPrimitives | InventoryLotPrimitives[] | null;
  createdAt: Date;
  expiresAt: Date;
}

interface MongoPantryQuotaDocument {
  _id: string;
  ownerUserId: string;
  activeProductTypes: number;
  activeInventoryLots: number;
  savedShoppingLists: number;
  lotsByProductType: Record<string, number>;
  updatedAt: Date;
  deleting?: boolean;
  mutationVersion?: number;
  expiresAt?: Date;
}

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
    await this.ensureQuota(mutation.receipt.ownerUserId);
    const response = mutation.updatedLot?.toPrimitives() ?? null;

    return this.runIdempotentTransaction(mutation.receipt, async (session) => {
      const expected = mutation.expectedLot.toPrimitives();
      const filter = {
        id: expected.id,
        userId: mutation.receipt.ownerUserId,
        updatedAt: expected.updatedAt,
        quantity: expected.quantity,
        archivedAt: { $exists: false },
      };

      await this.assertPantryAvailable(mutation.receipt.ownerUserId, session);
      await this.assertProductTypeNotDeleting(mutation.expectedLot, session);
      if (mutation.updatedLot) {
        const update = mutation.updatedLot.toPrimitives();
        const result = await this.inventoryLotModel.updateOne(
          filter,
          {
            $set: activeLotDocument(update),
            $unset: { archivedAt: 1, archivedReason: 1, retentionExpiresAt: 1 },
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
          throw new PantryMutationConflictError('Pantry quota is inconsistent');
        }
      }

      if (mutation.wasteEvent) {
        await this.wasteEventModel.create(
          [mutation.wasteEvent.toPrimitives()],
          { session },
        );
      }
      return response;
    });
  }

  async checkout(
    mutation: CloseShoppingPurchaseMutation,
  ): Promise<IdempotentMutationResult<InventoryLotPrimitives[]>> {
    await this.ensureQuota(mutation.receipt.ownerUserId);
    const response = mutation.lots.map((lot) => lot.toPrimitives());

    return this.runIdempotentTransaction(mutation.receipt, async (session) => {
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
    });
  }

  async createInventoryLot(lot: InventoryLot): Promise<InventoryLot> {
    await this.ensureQuota(lot.userId.toString());
    return this.runAtomicMutation(async (session) => {
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
    await this.ensureQuota(expected.userId.toString());
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(expected.userId.toString(), session);
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
        await this.decrementMongoLotQuota(
          expected,
          archived.updatedAt,
          session,
        );
      }
      return archived;
    });
  }

  async restoreInventoryLot(
    expected: InventoryLot,
    restored: InventoryLot,
  ): Promise<InventoryLot> {
    await this.ensureQuota(expected.userId.toString());
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(expected.userId.toString(), session);
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
        const quota = checkoutQuotaUpdate(
          expected.userId.toString(),
          [expected.productTypeId.toString()],
          restored.updatedAt,
        );
        const quotaResult = await this.quotas.updateOne(
          quota.filter,
          quota.update,
          { session },
        );
        if (quotaResult.modifiedCount !== 1) {
          throw new PantryQuotaExceededError(
            'Pantry inventory lot quota exceeded',
          );
        }
      }
      return restored;
    });
  }

  async createProductType(productType: ProductType): Promise<ProductType> {
    await this.ensureQuota(productType.userId.toString());
    return this.runAtomicMutation(async (session) => {
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
    await this.ensureQuota(expected.userId.toString());
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(expected.userId.toString(), session);
      await this.replaceMongoProductType(expected, archived, session);
      if (!expected.archivedAt && archived.archivedAt) {
        await this.decrementMongoSimpleQuota(
          expected.userId.toString(),
          'activeProductTypes',
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
    await this.ensureQuota(expected.userId.toString());
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(expected.userId.toString(), session);
      await this.replaceMongoProductType(expected, restored, session);
      if (expected.archivedAt && !restored.archivedAt) {
        await this.incrementMongoSimpleQuota(
          expected.userId.toString(),
          'activeProductTypes',
          MAX_ACTIVE_PRODUCT_TYPES_PER_USER,
          restored.updatedAt,
          session,
        );
      }
      return restored;
    });
  }

  async createShoppingList(list: ShoppingList): Promise<ShoppingList> {
    await this.ensureQuota(list.ownerUserId);
    return this.runAtomicMutation(async (session) => {
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
    });
  }

  async createProduct(product: Product): Promise<Product> {
    const ownerUserId = product.userId.toString();
    await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(ownerUserId, session);
      await this.connection
        .collection('products')
        .insertOne(product.toPrimitives(), { session });
      return product;
    });
  }

  async updateProduct(expected: Product, updated: Product): Promise<Product> {
    const ownerUserId = expected.userId.toString();
    await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(ownerUserId, session);
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
    await this.ensureQuota(ownerUserId);
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(ownerUserId, session);
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
    await this.ensureQuota(expected.ownerUserId);
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(expected.ownerUserId, session);
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
    });
  }

  async deleteShoppingList(list: ShoppingList): Promise<void> {
    await this.ensureQuota(list.ownerUserId);
    await this.runAtomicMutation(async (session) => {
      const result = await this.connection
        .collection('shoppingLists')
        .deleteOne({ id: list.id, ownerUserId: list.ownerUserId }, { session });
      if (result.deletedCount !== 1) {
        throw new PantryMutationConflictError();
      }
      await this.decrementMongoSimpleQuota(
        list.ownerUserId,
        'savedShoppingLists',
        list.toPrimitives().updatedAt,
        session,
      );
    });
  }

  async deleteInventoryLot(lot: InventoryLot): Promise<void> {
    await this.ensureQuota(lot.userId.toString());
    await this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(lot.userId.toString(), session);
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
      if (!lot.archivedAt)
        await this.decrementMongoLotQuota(lot, new Date(), session);
    });
  }

  async deleteProductType(productType: ProductType): Promise<void> {
    await this.ensureQuota(productType.userId.toString());
    await this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(productType.userId.toString(), session);
      if (
        await this.inventoryLotModel
          .exists({
            productTypeId: productType.id.toString(),
            archivedAt: { $exists: false },
          })
          .session(session)
      ) {
        throw new PantryMutationConflictError(
          'Product type still has active inventory',
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
    });
  }

  async beginProductTypeDeletion(productType: ProductType): Promise<void> {
    const ownerUserId = productType.userId.toString();
    await this.ensureQuota(ownerUserId);
    await this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(ownerUserId, session);
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
    await this.ensureQuota(expected.userId.toString());
    return this.runAtomicMutation(async (session) => {
      await this.assertPantryAvailable(expected.userId.toString(), session);
      await this.replaceMongoProductType(expected, updated, session);
      return updated;
    });
  }

  async beginPantryDeletion(
    ownerUserId: string,
    preserveDeletionLockUntil?: Date,
  ): Promise<void> {
    await this.ensureQuota(ownerUserId);
    await this.quotas.updateOne(
      { _id: ownerUserId },
      {
        $set: {
          deleting: true,
          ...(preserveDeletionLockUntil
            ? { expiresAt: preserveDeletionLockUntil }
            : {}),
        },
      },
    );
  }

  async completePantryDeletion(
    ownerUserId: string,
    preserveDeletionLockUntil?: Date,
  ): Promise<void> {
    await this.operations.deleteMany({ ownerUserId });
    if (preserveDeletionLockUntil) {
      await this.connection
        .collection<{
          _id: string;
          ownerUserId: string;
          deleting: boolean;
          expiresAt: Date;
        }>('pantry_quotas')
        .replaceOne(
          { _id: ownerUserId },
          {
            ownerUserId,
            deleting: true,
            expiresAt: preserveDeletionLockUntil,
          },
          { upsert: true },
        );
      return;
    }
    await this.quotas.deleteOne({
      _id: ownerUserId,
      expiresAt: { $exists: false },
    });
  }

  private async assertPantryAvailable(
    ownerUserId: string,
    session: ClientSession,
  ): Promise<void> {
    // Writing the owner row serializes deletion against otherwise counter-neutral mutations.
    const result = await this.quotas.updateOne(
      { _id: ownerUserId, deleting: { $exists: false } },
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
    mutation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    let value: T | undefined;
    let committed = false;
    try {
      await session.withTransaction(async () => {
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
        deleting: { $exists: false },
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
        deleting: { $exists: false },
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
        deleting: { $exists: false },
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

        await this.assertPantryAvailable(receipt.ownerUserId, session);
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

  private async ensureQuota(ownerUserId: string): Promise<void> {
    if (await this.quotas.findOne({ _id: ownerUserId })) {
      return;
    }
    const [lots, activeProductTypes, savedShoppingLists] = await Promise.all([
      this.inventoryLotModel
        .find({ userId: ownerUserId, archivedAt: { $exists: false } })
        .select({ productTypeId: 1, _id: 0 })
        .lean(),
      this.productTypeModel.countDocuments({
        userId: ownerUserId,
        archivedAt: { $exists: false },
      }),
      this.connection
        .collection('shoppingLists')
        .countDocuments({ ownerUserId }),
    ]);
    const lotsByProductType = lots.reduce<Record<string, number>>(
      (counts, lot) => {
        counts[lot.productTypeId] = (counts[lot.productTypeId] ?? 0) + 1;
        return counts;
      },
      {},
    );
    try {
      await this.quotas.insertOne({
        _id: ownerUserId,
        ownerUserId,
        activeProductTypes,
        activeInventoryLots: lots.length,
        savedShoppingLists,
        lotsByProductType,
        updatedAt: new Date(),
      });
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
    }
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
      deleting: { $exists: false },
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
