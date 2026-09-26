import { InjectModel } from '@nestjs/mongoose';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import {
  DepletionRulePrimitives,
  ProductType,
  ProductTypePlanningSettingsPrimitives,
  ProductTypePrimitives,
} from '../../../domain/entities/product-type.entity';
import {
  MAX_ARCHIVED_PANTRY_PAGE_SIZE,
  MAX_ARCHIVED_PRODUCT_TYPES_PER_USER,
  MAX_PRODUCT_TYPE_SEARCH_RESULTS,
} from '../../../application/constants/query-limits';
import { getArchivedRecordRetentionExpiresAt } from '../../../application/policies/retention-policy';
import {
  CursorPage,
  CursorPageOptions,
} from '../../../domain/repositories/cursor-page';
import { ProductTypeRepository } from '../../../domain/repositories/product-type.repository';
import { ProductTypeId } from '../../../domain/value-objects/product-type-id.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { ProductTypeDocument } from './schemas/product-type.schema';

type PersistedDepletionRule = Omit<DepletionRulePrimitives, 'everyPeriod'> & {
  everyPeriod: string;
};

type PersistedProductType = Omit<
  ProductTypePrimitives,
  'defaultDepletionRule' | 'planningSettings'
> & {
  normalizedBaseName: string;
  defaultDepletionRule?: PersistedDepletionRule;
  planningSettings?: ProductTypePlanningSettingsPrimitives;
};

@Injectable()
export class MongoProductTypeRepository implements ProductTypeRepository {
  constructor(
    @InjectModel(ProductTypeDocument.name)
    private readonly productTypeModel: Model<ProductTypeDocument>,
    private readonly configService: ConfigService = defaultConfigService(),
  ) {}

  async save(productType: ProductType): Promise<ProductType> {
    const primitives = productType.toPrimitives();
    const normalizedBaseName = normalizeBaseName(primitives.baseName);
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

    const savedProductType = await this.productTypeModel
      .findOneAndUpdate(
        {
          userId: primitives.userId,
          normalizedBaseName,
        },
        {
          $setOnInsert: {
            id: primitives.id,
            userId: primitives.userId,
            createdAt: primitives.createdAt,
          },
          $set: {
            baseName: primitives.baseName,
            category: primitives.category,
            defaultUnit: primitives.defaultUnit,
            defaultDepletionRule: primitives.defaultDepletionRule,
            planningSettings: primitives.planningSettings,
            shoppingMetadata: primitives.shoppingMetadata,
            ...archiveSet,
            updatedAt: primitives.updatedAt,
            normalizedBaseName,
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

    return this.toDomain(savedProductType);
  }

  async findById(id: ProductTypeId): Promise<ProductType | null> {
    const productType = await this.productTypeModel
      .findOne({ id: id.toString() })
      .lean()
      .exec();

    return productType ? this.toDomain(productType) : null;
  }

  async findByUserId(userId: UserId): Promise<ProductType[]> {
    const productTypes = await this.productTypeModel
      .find({ userId: userId.toString(), archivedAt: { $exists: false } })
      .sort({ baseName: 1 })
      .lean()
      .exec();

    return productTypes.map((productType) =>
      this.toDomain(productType as PersistedProductType),
    );
  }

  async findArchivedByUserId(userId: UserId): Promise<ProductType[]> {
    const items: ProductType[] = [];
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
  ): Promise<CursorPage<ProductType>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeMongoArchiveCursor(options.cursor);
    const cursorFilter = cursor
      ? {
          $or: [
            { archivedAt: { $lt: cursor.archivedAt } },
            { archivedAt: cursor.archivedAt, id: { $gt: cursor.id } },
          ],
        }
      : {};
    const productTypes = await this.productTypeModel
      .find({
        userId: userId.toString(),
        archivedAt: { $exists: true },
        ...cursorFilter,
      })
      .sort({ archivedAt: -1, id: 1 })
      .limit(limit + 1)
      .lean()
      .exec();
    const pageItems = productTypes.slice(0, limit);
    const nextCursor =
      productTypes.length > limit
        ? encodeMongoArchiveCursor(pageItems[pageItems.length - 1])
        : undefined;

    return {
      items: pageItems.map((productType) =>
        this.toDomain(productType as PersistedProductType),
      ),
      nextCursor,
    };
  }

  async searchByUserId(
    userId: UserId,
    search?: string,
  ): Promise<ProductType[]> {
    const normalizedSearch = search ? normalizeBaseName(search) : undefined;
    const query = normalizedSearch
      ? {
          userId: userId.toString(),
          archivedAt: { $exists: false },
          normalizedBaseName: { $regex: escapeRegExp(normalizedSearch) },
        }
      : { userId: userId.toString(), archivedAt: { $exists: false } };

    const productTypes = await this.productTypeModel
      .find(query)
      .sort({ baseName: 1 })
      .limit(MAX_PRODUCT_TYPE_SEARCH_RESULTS)
      .lean()
      .exec();

    return productTypes.map((productType) =>
      this.toDomain(productType as PersistedProductType),
    );
  }

  async findByBaseName(
    userId: UserId,
    baseName: string,
  ): Promise<ProductType | null> {
    const productType = await this.productTypeModel
      .findOne({
        userId: userId.toString(),
        normalizedBaseName: normalizeBaseName(baseName),
        archivedAt: { $exists: false },
      })
      .lean()
      .exec();

    return productType ? this.toDomain(productType) : null;
  }

  async reassignUserOwnership(
    fromUserId: UserId,
    toUserId: UserId,
  ): Promise<number> {
    const result = await this.productTypeModel
      .updateMany(
        { userId: fromUserId.toString() },
        { $set: { userId: toUserId.toString(), updatedAt: new Date() } },
      )
      .exec();

    return result.modifiedCount;
  }

  async delete(id: ProductTypeId): Promise<void> {
    await this.productTypeModel.deleteOne({ id: id.toString() }).exec();
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    const result = await this.productTypeModel
      .deleteMany({ userId: userId.toString() })
      .exec();

    return result.deletedCount;
  }

  private toDomain(productType: PersistedProductType): ProductType {
    return ProductType.fromPrimitives({
      id: productType.id,
      userId: productType.userId,
      baseName: productType.baseName,
      category: productType.category,
      defaultUnit: productType.defaultUnit,
      defaultDepletionRule: productType.defaultDepletionRule
        ? {
            ...productType.defaultDepletionRule,
            everyPeriod: toDepletionPeriod(
              productType.defaultDepletionRule.everyPeriod,
            ),
            anchorDate: new Date(productType.defaultDepletionRule.anchorDate),
          }
        : undefined,
      planningSettings: productType.planningSettings,
      shoppingMetadata: productType.shoppingMetadata,
      archivedAt: productType.archivedAt
        ? new Date(productType.archivedAt)
        : undefined,
      archivedReason: productType.archivedReason,
      createdAt: new Date(productType.createdAt),
      updatedAt: new Date(productType.updatedAt),
    });
  }
}

function normalizeBaseName(value: string): string {
  return value.trim().toLocaleLowerCase('es');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toDepletionPeriod(
  value: string,
): DepletionRulePrimitives['everyPeriod'] {
  if (value === 'day' || value === 'week' || value === 'month') {
    return value;
  }

  throw new Error(`Unsupported persisted depletion interval period: ${value}`);
}

interface MongoArchiveCursor {
  archivedAt: Date;
  id: string;
}

function clampLimit(limit: number): number {
  return Math.min(
    Math.max(1, Math.floor(limit || MAX_ARCHIVED_PANTRY_PAGE_SIZE)),
    MAX_ARCHIVED_PRODUCT_TYPES_PER_USER,
  );
}

function encodeMongoArchiveCursor(
  item: Pick<PersistedProductType, 'archivedAt' | 'id'> | undefined,
): string | undefined {
  if (!item?.archivedAt) {
    return undefined;
  }

  return Buffer.from(
    JSON.stringify({
      archivedAt: new Date(item.archivedAt).toISOString(),
      id: item.id,
    }),
    'utf8',
  ).toString('base64url');
}

function decodeMongoArchiveCursor(
  cursor: string | undefined,
): MongoArchiveCursor | undefined {
  if (!cursor) {
    return undefined;
  }

  const parsed = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as {
    archivedAt?: string;
    id?: string;
  };

  if (!parsed.archivedAt || !parsed.id) {
    throw new Error('Invalid archived product type cursor');
  }

  return {
    archivedAt: new Date(parsed.archivedAt),
    id: parsed.id,
  };
}

function defaultConfigService(): ConfigService {
  return {
    get: emptyConfigValue,
  } as unknown as ConfigService;
}

function emptyConfigValue(): undefined {
  return undefined;
}
