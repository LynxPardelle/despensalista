import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WasteEvent,
  WasteEventPrimitives,
} from '../../../domain/entities/waste-event.entity';
import { WasteEventRepository } from '../../../domain/repositories/waste-event.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type WasteEventItem = Omit<WasteEventPrimitives, 'occurredAt' | 'createdAt'> & {
  entityType: 'WASTE_EVENT';
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class DynamoDbWasteEventRepository implements WasteEventRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>(
      'DYNAMODB_INVENTORY_LOTS_TABLE',
    );
  }

  async save(event: WasteEvent): Promise<WasteEvent> {
    const item = this.toItem(event.toPrimitives());

    await this.dynamoDb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );

    return this.toDomain(item);
  }

  async findRecentByUserId(userId: UserId, limit = 10): Promise<WasteEvent[]> {
    const items = await this.findByUserId(userId, {
      limit: Math.min(Math.max(1, Math.trunc(limit)), 50),
    });

    return items.map((item) => this.toDomain(item));
  }

  async findSinceByUserId(userId: UserId, since: Date): Promise<WasteEvent[]> {
    const items = await this.findByUserId(userId, { since, limit: 1000 });

    return items.map((item) => this.toDomain(item));
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    let deletedCount = 0;
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
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      const pageItems = (result.Items ?? []) as Array<
        WasteEventItem | { entityType?: string }
      >;
      const items = pageItems.filter(isWasteEventItem);

      await Promise.all(
        items.map((item) =>
          this.dynamoDb.send(
            new DeleteCommand({
              TableName: this.tableName,
              Key: {
                id: item.id,
              },
            }),
          ),
        ),
      );
      deletedCount += items.length;
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return deletedCount;
  }

  private async findByUserId(
    userId: UserId,
    options: { since?: Date; limit: number },
  ): Promise<WasteEventItem[]> {
    const items: WasteEventItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    const sinceTime = options.since?.getTime();

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
          Limit: options.limit,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );
      const pageItems = (result.Items ?? []) as Array<
        WasteEventItem | { entityType?: string; updatedAt?: string }
      >;
      items.push(
        ...pageItems.filter(isWasteEventItem).filter((item) => {
          if (sinceTime === undefined) {
            return true;
          }

          return new Date(item.occurredAt).getTime() >= sinceTime;
        }),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;

      const lastUpdatedAt = pageItems[pageItems.length - 1]?.updatedAt;
      if (
        sinceTime !== undefined &&
        lastUpdatedAt &&
        new Date(lastUpdatedAt).getTime() < sinceTime
      ) {
        exclusiveStartKey = undefined;
      }
    } while (exclusiveStartKey && items.length < options.limit);

    return items.slice(0, options.limit);
  }

  private toItem(primitives: WasteEventPrimitives): WasteEventItem {
    return {
      entityType: 'WASTE_EVENT',
      id: primitives.id,
      userId: primitives.userId,
      productTypeId: primitives.productTypeId,
      inventoryLotId: primitives.inventoryLotId,
      productName: primitives.productName,
      quantity: primitives.quantity,
      unit: primitives.unit,
      reason: primitives.reason,
      note: primitives.note,
      estimatedLoss: primitives.estimatedLoss,
      occurredAt: primitives.occurredAt.toISOString(),
      createdAt: primitives.createdAt.toISOString(),
      updatedAt: primitives.occurredAt.toISOString(),
    };
  }

  private toDomain(item: WasteEventItem): WasteEvent {
    return WasteEvent.fromPrimitives({
      id: item.id,
      userId: item.userId,
      productTypeId: item.productTypeId,
      inventoryLotId: item.inventoryLotId,
      productName: item.productName,
      quantity: item.quantity,
      unit: item.unit,
      reason: item.reason,
      note: item.note,
      estimatedLoss: item.estimatedLoss,
      occurredAt: new Date(item.occurredAt),
      createdAt: new Date(item.createdAt),
    });
  }
}

function isWasteEventItem(
  item: WasteEventItem | { entityType?: string },
): item is WasteEventItem {
  return item.entityType === 'WASTE_EVENT';
}
