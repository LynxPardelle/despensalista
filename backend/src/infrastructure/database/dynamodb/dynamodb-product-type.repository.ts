import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  DepletionRulePrimitives,
  ProductTypePriceHistoryEntryPrimitives,
  ProductType,
  ProductTypePlanningSettingsPrimitives,
  ProductTypePrimitives,
  ProductTypeShoppingMetadataPrimitives,
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
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type ProductTypeItem = Omit<
  ProductTypePrimitives,
  | 'defaultDepletionRule'
  | 'shoppingMetadata'
  | 'archivedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  entityType: 'PRODUCT_TYPE';
  normalizedBaseName: string;
  defaultDepletionRule?: PersistedDepletionRule;
  planningSettings?: ProductTypePlanningSettingsPrimitives;
  shoppingMetadata?: PersistedShoppingMetadata;
  archivedAt?: string;
  expiresAtEpochSeconds?: number;
  createdAt: string;
  updatedAt: string;
};

type PersistedDepletionRule = Omit<DepletionRulePrimitives, 'anchorDate'> & {
  anchorDate: string;
};

type PersistedPriceHistoryEntry = Omit<
  ProductTypePriceHistoryEntryPrimitives,
  'recordedAt'
> & {
  recordedAt: string;
};

type PersistedShoppingMetadata = Omit<
  ProductTypeShoppingMetadataPrimitives,
  'priceHistory'
> & {
  priceHistory?: PersistedPriceHistoryEntry[];
};

@Injectable()
export class DynamoDbProductTypeRepository implements ProductTypeRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    private readonly configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>(
      'DYNAMODB_PRODUCT_TYPES_TABLE',
    );
  }

  async save(productType: ProductType): Promise<ProductType> {
    const primitives = productType.toPrimitives();
    const existing = await this.findByUserBaseName(
      UserId.fromString(primitives.userId),
      primitives.baseName,
    );
    const existingPrimitives = existing?.toPrimitives();
    const item = this.toItem({
      ...primitives,
      id: existingPrimitives?.id ?? primitives.id,
      createdAt: existingPrimitives?.createdAt ?? primitives.createdAt,
    });

    await this.dynamoDb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );

    return this.toDomain(item);
  }

  async findById(id: ProductTypeId): Promise<ProductType | null> {
    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'id = :id',
        ExpressionAttributeValues: {
          ':id': id.toString(),
        },
        Limit: 1,
      }),
    );
    const items = (result.Items ?? []) as ProductTypeItem[];
    const item = items[0];

    return item ? this.toDomain(item) : null;
  }

  async findByUserId(userId: UserId): Promise<ProductType[]> {
    const productTypes = await this.findAllByUserId(userId);

    return productTypes
      .filter((productType) => !productType.archivedAt)
      .sort((a, b) => a.baseName.localeCompare(b.baseName, 'es'));
  }

  async findArchivedByUserId(userId: UserId): Promise<ProductType[]> {
    const productTypes: ProductType[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.findArchivedPageByUserId(userId, {
        limit: MAX_ARCHIVED_PANTRY_PAGE_SIZE,
        cursor,
      });
      productTypes.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    return productTypes;
  }

  async findArchivedPageByUserId(
    userId: UserId,
    options: CursorPageOptions,
  ): Promise<CursorPage<ProductType>> {
    const limit = clampArchivedLimit(options.limit);
    const items: ProductTypeItem[] = [];
    let exclusiveStartKey = decodeDynamoCursor(options.cursor);

    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'UserBaseNameIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId.toString(),
          },
          Limit: limit - items.length,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      items.push(
        ...((result.Items ?? []) as ProductTypeItem[]).filter((item) =>
          Boolean(item.archivedAt),
        ),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey && items.length < limit);

    const pageItems = items.slice(0, limit);

    return {
      items: pageItems
        .map((item) => this.toDomain(item))
        .sort(
          (a, b) =>
            (b.archivedAt?.getTime() ?? 0) - (a.archivedAt?.getTime() ?? 0),
        ),
      nextCursor: exclusiveStartKey
        ? encodeDynamoCursor(exclusiveStartKey)
        : undefined,
    };
  }

  async searchByUserId(
    userId: UserId,
    search?: string,
  ): Promise<ProductType[]> {
    const productTypes = await this.findByUserId(userId);
    const normalizedSearch = search ? normalizeBaseName(search) : undefined;

    if (!normalizedSearch) {
      return productTypes.slice(0, MAX_PRODUCT_TYPE_SEARCH_RESULTS);
    }

    return productTypes
      .filter((productType) =>
        normalizeBaseName(productType.baseName).includes(normalizedSearch),
      )
      .slice(0, MAX_PRODUCT_TYPE_SEARCH_RESULTS);
  }

  async findByBaseName(
    userId: UserId,
    baseName: string,
  ): Promise<ProductType | null> {
    const productType = await this.findByUserBaseName(userId, baseName);

    return productType && !productType.archivedAt ? productType : null;
  }

  async reassignUserOwnership(
    fromUserId: UserId,
    toUserId: UserId,
  ): Promise<number> {
    const productTypes = await this.findAllByUserId(fromUserId);

    await Promise.all(
      productTypes.map((productType) =>
        this.dynamoDb.send(
          new PutCommand({
            TableName: this.tableName,
            Item: this.toItem({
              ...productType.toPrimitives(),
              userId: toUserId.toString(),
              updatedAt: new Date(),
            }),
          }),
        ),
      ),
    );

    return productTypes.length;
  }

  async delete(id: ProductTypeId): Promise<void> {
    await this.dynamoDb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          id: id.toString(),
        },
      }),
    );
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    const productTypes = await this.findAllByUserId(userId);

    await Promise.all(
      productTypes.map((productType) => this.delete(productType.id)),
    );

    return productTypes.length;
  }

  private async findAllByUserId(userId: UserId): Promise<ProductType[]> {
    const items: ProductTypeItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'UserBaseNameIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId.toString(),
          },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      items.push(...((result.Items ?? []) as ProductTypeItem[]));
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return items.map((item) => this.toDomain(item));
  }

  private async findByUserBaseName(
    userId: UserId,
    baseName: string,
  ): Promise<ProductType | null> {
    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'UserBaseNameIndex',
        KeyConditionExpression:
          'userId = :userId AND normalizedBaseName = :normalizedBaseName',
        ExpressionAttributeValues: {
          ':userId': userId.toString(),
          ':normalizedBaseName': normalizeBaseName(baseName),
        },
        Limit: 1,
      }),
    );
    const items = (result.Items ?? []) as ProductTypeItem[];
    const item = items[0];

    return item ? this.toDomain(item) : null;
  }

  private toItem(primitives: ProductTypePrimitives): ProductTypeItem {
    const retentionExpiresAt = getArchivedRecordRetentionExpiresAt(
      primitives.archivedAt,
      this.configService,
    );

    return {
      entityType: 'PRODUCT_TYPE',
      id: primitives.id,
      userId: primitives.userId,
      baseName: primitives.baseName,
      normalizedBaseName: normalizeBaseName(primitives.baseName),
      category: primitives.category,
      defaultUnit: primitives.defaultUnit,
      defaultDepletionRule: primitives.defaultDepletionRule
        ? {
            ...primitives.defaultDepletionRule,
            anchorDate:
              primitives.defaultDepletionRule.anchorDate.toISOString(),
          }
        : undefined,
      planningSettings: primitives.planningSettings,
      shoppingMetadata: serializeShoppingMetadata(primitives.shoppingMetadata),
      archivedAt: primitives.archivedAt?.toISOString(),
      expiresAtEpochSeconds: retentionExpiresAt
        ? Math.floor(retentionExpiresAt.getTime() / 1000)
        : undefined,
      archivedReason: primitives.archivedReason,
      createdAt: primitives.createdAt.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
    };
  }

  private toDomain(item: ProductTypeItem): ProductType {
    return ProductType.fromPrimitives({
      id: item.id,
      userId: item.userId,
      baseName: item.baseName,
      category: item.category,
      defaultUnit: item.defaultUnit,
      defaultDepletionRule: item.defaultDepletionRule
        ? {
            ...item.defaultDepletionRule,
            anchorDate: new Date(item.defaultDepletionRule.anchorDate),
          }
        : undefined,
      planningSettings: item.planningSettings,
      shoppingMetadata: deserializeShoppingMetadata(item.shoppingMetadata),
      archivedAt: item.archivedAt ? new Date(item.archivedAt) : undefined,
      archivedReason: item.archivedReason,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    });
  }
}

function normalizeBaseName(value: string): string {
  return value.trim().toLocaleLowerCase('es');
}

function clampArchivedLimit(limit: number): number {
  return Math.min(
    Math.max(1, Math.floor(limit || MAX_ARCHIVED_PANTRY_PAGE_SIZE)),
    MAX_ARCHIVED_PRODUCT_TYPES_PER_USER,
  );
}

function encodeDynamoCursor(
  cursor: Record<string, unknown> | undefined,
): string | undefined {
  return cursor
    ? Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
    : undefined;
}

function decodeDynamoCursor(
  cursor: string | undefined,
): Record<string, unknown> | undefined {
  if (!cursor) {
    return undefined;
  }

  try {
    return JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid archived product type cursor');
  }
}

function serializeShoppingMetadata(
  metadata: ProductTypeShoppingMetadataPrimitives | undefined,
): PersistedShoppingMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  return {
    ...metadata,
    priceHistory: metadata.priceHistory?.map((entry) => ({
      ...entry,
      recordedAt: entry.recordedAt.toISOString(),
    })),
  };
}

function deserializeShoppingMetadata(
  metadata: PersistedShoppingMetadata | undefined,
): ProductTypeShoppingMetadataPrimitives | undefined {
  if (!metadata) {
    return undefined;
  }

  return {
    ...metadata,
    priceHistory: metadata.priceHistory?.map((entry) => ({
      ...entry,
      recordedAt: new Date(entry.recordedAt),
    })),
  };
}
