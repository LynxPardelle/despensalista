import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
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
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type InventoryLotItem = Omit<
  InventoryLotPrimitives,
  'expiresAt' | 'purchaseDate' | 'archivedAt' | 'createdAt' | 'updatedAt'
> & {
  entityType: 'INVENTORY_LOT';
  expiresAt?: string;
  purchaseDate?: string;
  archivedAt?: string;
  expiresAtEpochSeconds?: number;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class DynamoDbInventoryLotRepository implements InventoryLotRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    private readonly configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>(
      'DYNAMODB_INVENTORY_LOTS_TABLE',
    );
  }

  async save(lot: InventoryLot): Promise<InventoryLot> {
    const item = this.toItem(lot.toPrimitives());

    await this.dynamoDb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );

    return this.toDomain(item);
  }

  async findById(id: InventoryLotId): Promise<InventoryLot | null> {
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
    const items = (result.Items ?? []) as InventoryLotItem[];
    const item = items[0];

    return item?.entityType === 'INVENTORY_LOT' ? this.toDomain(item) : null;
  }

  async findByUserId(userId: UserId): Promise<InventoryLot[]> {
    const lots = await this.findAllByUserId(userId);

    return lots
      .filter((lot) => !lot.archivedAt)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async findArchivedByUserId(userId: UserId): Promise<InventoryLot[]> {
    const lots: InventoryLot[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.findArchivedPageByUserId(userId, {
        limit: MAX_ARCHIVED_PANTRY_PAGE_SIZE,
        cursor,
      });
      lots.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    return lots;
  }

  async findArchivedPageByUserId(
    userId: UserId,
    options: CursorPageOptions,
  ): Promise<CursorPage<InventoryLot>> {
    const limit = clampArchivedLimit(options.limit);
    const items: InventoryLotItem[] = [];
    let exclusiveStartKey = decodeDynamoCursor(options.cursor);

    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'UserUpdatedAtIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId.toString(),
          },
          ScanIndexForward: false,
          Limit: limit - items.length,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      items.push(
        ...((result.Items ?? []) as InventoryLotItem[])
          .filter((item) => item.entityType === 'INVENTORY_LOT')
          .filter((item) => Boolean(item.archivedAt)),
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

  async findByProductTypeId(
    productTypeId: ProductTypeId,
  ): Promise<InventoryLot[]> {
    const lots = await this.findAllByProductTypeId(productTypeId);

    return lots.filter((lot) => !lot.archivedAt);
  }

  async reassignUserOwnership(
    fromUserId: UserId,
    toUserId: UserId,
  ): Promise<number> {
    const lots = await this.findAllByUserId(fromUserId);

    await Promise.all(
      lots.map((lot) =>
        this.dynamoDb.send(
          new PutCommand({
            TableName: this.tableName,
            Item: this.toItem({
              ...lot.toPrimitives(),
              userId: toUserId.toString(),
              updatedAt: new Date(),
            }),
          }),
        ),
      ),
    );

    return lots.length;
  }

  async delete(id: InventoryLotId): Promise<void> {
    await this.dynamoDb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          id: id.toString(),
        },
      }),
    );
  }

  async deleteByProductTypeId(productTypeId: ProductTypeId): Promise<void> {
    const lots = await this.findAllByProductTypeId(productTypeId);

    await Promise.all(lots.map((lot) => this.delete(lot.id)));
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    const lots = await this.findAllByUserId(userId);

    await Promise.all(lots.map((lot) => this.delete(lot.id)));

    return lots.length;
  }

  private async findAllByProductTypeId(
    productTypeId: ProductTypeId,
  ): Promise<InventoryLot[]> {
    const items: InventoryLotItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.dynamoDb.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression:
            'entityType = :entityType AND productTypeId = :productTypeId',
          ExpressionAttributeValues: {
            ':entityType': 'INVENTORY_LOT',
            ':productTypeId': productTypeId.toString(),
          },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      items.push(
        ...((result.Items ?? []) as InventoryLotItem[]).filter(
          (item) =>
            item.entityType === 'INVENTORY_LOT' &&
            item.productTypeId === productTypeId.toString(),
        ),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return items
      .map((item) => this.toDomain(item))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  private async findAllByUserId(userId: UserId): Promise<InventoryLot[]> {
    const items: InventoryLotItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'UserUpdatedAtIndex',
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId.toString(),
          },
          ScanIndexForward: false,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      items.push(
        ...((result.Items ?? []) as InventoryLotItem[]).filter(
          (item) => item.entityType === 'INVENTORY_LOT',
        ),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return items.map((item) => this.toDomain(item));
  }

  private toItem(primitives: InventoryLotPrimitives): InventoryLotItem {
    const retentionExpiresAt = getArchivedRecordRetentionExpiresAt(
      primitives.archivedAt,
      this.configService,
    );

    return {
      entityType: 'INVENTORY_LOT',
      id: primitives.id,
      userId: primitives.userId,
      productTypeId: primitives.productTypeId,
      variantName: primitives.variantName,
      quantity: primitives.quantity,
      unit: primitives.unit,
      expiresAt: primitives.expiresAt?.toISOString(),
      purchaseDate: primitives.purchaseDate?.toISOString(),
      archivedAt: primitives.archivedAt?.toISOString(),
      expiresAtEpochSeconds: retentionExpiresAt
        ? Math.floor(retentionExpiresAt.getTime() / 1000)
        : undefined,
      archivedReason: primitives.archivedReason,
      createdAt: primitives.createdAt.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
    };
  }

  private toDomain(item: InventoryLotItem): InventoryLot {
    return InventoryLot.fromPrimitives({
      id: item.id,
      userId: item.userId,
      productTypeId: item.productTypeId,
      variantName: item.variantName,
      quantity: item.quantity,
      unit: item.unit,
      expiresAt: item.expiresAt ? new Date(item.expiresAt) : undefined,
      purchaseDate: item.purchaseDate ? new Date(item.purchaseDate) : undefined,
      archivedAt: item.archivedAt ? new Date(item.archivedAt) : undefined,
      archivedReason: item.archivedReason,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    });
  }
}

function clampArchivedLimit(limit: number): number {
  return Math.min(
    Math.max(1, Math.floor(limit || MAX_ARCHIVED_PANTRY_PAGE_SIZE)),
    MAX_ARCHIVED_INVENTORY_LOTS_PER_USER,
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
    throw new Error('Invalid archived inventory lot cursor');
  }
}
