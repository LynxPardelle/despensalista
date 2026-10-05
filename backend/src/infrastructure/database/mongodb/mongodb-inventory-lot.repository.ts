import { InjectModel } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import {
  InventoryLot,
  InventoryLotPrimitives,
} from '../../../domain/entities/inventory-lot.entity';
import {
  MAX_ARCHIVED_PANTRY_PAGE_SIZE,
  MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
} from '../../../application/constants/query-limits';
import { getArchivedRecordRetentionExpiresAt } from '../../../application/policies/retention-policy';
import {
  CursorPage,
  CursorPageOptions,
} from '../../../domain/repositories/cursor-page';
import { InventoryLotRepository } from '../../../domain/repositories/inventory-lot.repository';
import { InventoryLotId } from '../../../domain/value-objects/inventory-lot-id.vo';
import { ProductTypeId } from '../../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { decodeArchiveCursor } from '../archive-cursor';
import { InventoryLotDocument } from './schemas/inventory-lot.schema';

type PersistedInventoryLot = Omit<
  InventoryLotPrimitives,
  'expiresAt' | 'purchaseDate'
> & {
  expiresAt?: Date | null;
  purchaseDate?: Date | null;
};

@Injectable()
export class MongoInventoryLotRepository implements InventoryLotRepository {
  constructor(
    @InjectModel(InventoryLotDocument.name)
    private readonly inventoryLotModel: Model<InventoryLotDocument>,
    private readonly configService: ConfigService = defaultConfigService(),
  ) {}

  async save(lot: InventoryLot): Promise<InventoryLot> {
    const primitives = lot.toPrimitives();
    const unsetFields: Record<string, 1> = {};

    if (!primitives.archivedAt) {
      unsetFields.archivedAt = 1;
    }

    if (!primitives.archivedReason) {
      unsetFields.archivedReason = 1;
    }

    const retentionExpiresAt = getArchivedRecordRetentionExpiresAt(
      primitives.archivedAt,
      this.configService,
    );
    if (!retentionExpiresAt) {
      unsetFields.retentionExpiresAt = 1;
    }

    const archiveSet = {
      ...(primitives.archivedAt ? { archivedAt: primitives.archivedAt } : {}),
      ...(primitives.archivedReason
        ? { archivedReason: primitives.archivedReason }
        : {}),
      ...(retentionExpiresAt ? { retentionExpiresAt } : {}),
    };
    const setPrimitives = { ...primitives };
    delete setPrimitives.archivedAt;
    delete setPrimitives.archivedReason;

    const savedLot = await this.inventoryLotModel
      .findOneAndUpdate(
        { id: primitives.id },
        {
          $set: {
            ...setPrimitives,
            ...archiveSet,
          },
          ...(Object.keys(unsetFields).length > 0
            ? { $unset: unsetFields }
            : {}),
        },
        {
          new: true,
          upsert: true,
        },
      )
      .lean()
      .exec();

    return this.toDomain(savedLot);
  }

  async findById(id: InventoryLotId): Promise<InventoryLot | null> {
    const lot = await this.inventoryLotModel
      .findOne({ id: id.toString() })
      .lean()
      .exec();

    return lot ? this.toDomain(lot) : null;
  }

  async findByUserId(userId: UserId): Promise<InventoryLot[]> {
    const lots = await this.inventoryLotModel
      .find({ userId: userId.toString(), archivedAt: { $exists: false } })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    return lots.map((lot) => this.toDomain(lot as PersistedInventoryLot));
  }

  async findArchivedByUserId(userId: UserId): Promise<InventoryLot[]> {
    const items: InventoryLot[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.findArchivedPageByUserId(userId, {
        limit: MAX_ARCHIVED_PANTRY_PAGE_SIZE,
        cursor,
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  async findArchivedPageByUserId(
    userId: UserId,
    options: CursorPageOptions,
  ): Promise<CursorPage<InventoryLot>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeMongoArchiveCursor(options.cursor, userId.toString());
    const cursorFilter = cursor
      ? {
          $or: [
            { archivedAt: { $lt: cursor.archivedAt } },
            { archivedAt: cursor.archivedAt, id: { $gt: cursor.id } },
          ],
        }
      : {};
    const lots = await this.inventoryLotModel
      .find({
        userId: userId.toString(),
        archivedAt: { $exists: true },
        ...cursorFilter,
      })
      .sort({ archivedAt: -1, id: 1 })
      .limit(limit + 1)
      .lean()
      .exec();
    const pageItems = lots.slice(0, limit);
    const nextCursor =
      lots.length > limit
        ? encodeMongoArchiveCursor(pageItems[pageItems.length - 1])
        : undefined;

    return {
      items: pageItems.map((lot) =>
        this.toDomain(lot as PersistedInventoryLot),
      ),
      nextCursor,
    };
  }

  async findByProductTypeId(
    productTypeId: ProductTypeId,
  ): Promise<InventoryLot[]> {
    const lots = await this.inventoryLotModel
      .find({
        productTypeId: productTypeId.toString(),
        archivedAt: { $exists: false },
      })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    return lots.map((lot) => this.toDomain(lot as PersistedInventoryLot));
  }

  async findAllByProductTypeId(
    productTypeId: ProductTypeId,
  ): Promise<InventoryLot[]> {
    const lots = await this.inventoryLotModel
      .find({ productTypeId: productTypeId.toString() })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    return lots.map((lot) => this.toDomain(lot as PersistedInventoryLot));
  }

  async reassignUserOwnership(
    fromUserId: UserId,
    toUserId: UserId,
  ): Promise<number> {
    const result = await this.inventoryLotModel
      .updateMany(
        { userId: fromUserId.toString() },
        { $set: { userId: toUserId.toString(), updatedAt: new Date() } },
      )
      .exec();

    return result.modifiedCount;
  }

  async delete(id: InventoryLotId): Promise<void> {
    await this.inventoryLotModel.deleteOne({ id: id.toString() }).exec();
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    const result = await this.inventoryLotModel
      .deleteMany({ userId: userId.toString() })
      .exec();

    return result.deletedCount;
  }

  private toDomain(lot: PersistedInventoryLot): InventoryLot {
    return InventoryLot.fromPrimitives({
      id: lot.id,
      userId: lot.userId,
      productTypeId: lot.productTypeId,
      variantName: lot.variantName,
      quantity: lot.quantity,
      unit: lot.unit,
      expiresAt: lot.expiresAt ?? undefined,
      purchaseDate: lot.purchaseDate ?? undefined,
      archivedAt: lot.archivedAt ?? undefined,
      archivedReason: lot.archivedReason,
      createdAt: new Date(lot.createdAt),
      updatedAt: new Date(lot.updatedAt),
    });
  }
}

function defaultConfigService(): ConfigService {
  return {
    get: emptyConfigValue,
  } as unknown as ConfigService;
}

function emptyConfigValue(): undefined {
  return undefined;
}

interface MongoArchiveCursor {
  archivedAt: Date;
  id: string;
}

function clampLimit(limit: number): number {
  return Math.min(
    Math.max(1, Math.floor(limit || MAX_ARCHIVED_PANTRY_PAGE_SIZE)),
    MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
  );
}

function encodeMongoArchiveCursor(
  item: Pick<PersistedInventoryLot, 'archivedAt' | 'id' | 'userId'> | undefined,
): string | undefined {
  if (!item?.archivedAt) {
    return undefined;
  }

  return Buffer.from(
    JSON.stringify({
      archivedAt: new Date(item.archivedAt).toISOString(),
      id: item.id,
      userId: item.userId,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeMongoArchiveCursor(
  cursor: string | undefined,
  expectedUserId: string,
): MongoArchiveCursor | undefined {
  const parsed = decodeArchiveCursor(
    cursor,
    expectedUserId,
    'Invalid archived inventory lot cursor',
  );
  if (!parsed) return undefined;

  return {
    archivedAt: new Date(parsed.archivedAt),
    id: parsed.id,
  };
}
