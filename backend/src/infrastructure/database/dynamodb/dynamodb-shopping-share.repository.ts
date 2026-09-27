import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ShoppingShare,
  ShoppingSharePrimitives,
} from '../../../domain/entities/shopping-share.entity';
import { ShoppingShareRepository } from '../../../domain/repositories/shopping-share.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type ShoppingShareItem = Omit<
  ShoppingSharePrimitives,
  'createdAt' | 'expiresAt' | 'revokedAt' | 'updatedAt'
> & {
  pk: string;
  entityType: 'SHOPPING_SHARE';
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  updatedAt: string;
  expiresAtEpochSeconds: number;
};

@Injectable()
export class DynamoDbShoppingShareRepository implements ShoppingShareRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async findByTokenHash(tokenHash: string): Promise<ShoppingShare | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: shoppingShareKey(tokenHash),
        },
      }),
    );

    return result.Item ? this.toDomain(result.Item as ShoppingShareItem) : null;
  }

  async findById(id: string): Promise<ShoppingShare | null> {
    const [item] = await this.query<ShoppingShareItem>({
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk',
      ExpressionAttributeValues: {
        ':gsi1pk': shoppingShareByIdKey(id),
      },
      Limit: 1,
    });

    return item ? this.toDomain(item) : null;
  }

  async listActiveByOwnerUserId(
    ownerUserId: string,
    now: Date,
  ): Promise<ShoppingShare[]> {
    const indexedItems = await this.query<ShoppingShareItem>({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk',
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ':gsi2pk': shoppingShareOwnerKey(ownerUserId),
      },
    });
    const indexedShares = indexedItems
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((item) => this.toDomain(item))
      .filter((share) => !share.isRevoked() && !share.isExpired(now))
      .slice(0, 25);

    return indexedShares;
  }

  async deleteByOwnerUserId(userId: UserId): Promise<number> {
    const indexedItems = await this.query<ShoppingShareItem>({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk',
      ExpressionAttributeValues: {
        ':gsi2pk': shoppingShareOwnerKey(userId.toString()),
      },
    });
    await Promise.all(
      indexedItems.map((item) =>
        this.dynamoDb.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: { pk: item.pk },
          }),
        ),
      ),
    );

    return indexedItems.length;
  }

  private toDomain(item: ShoppingShareItem): ShoppingShare {
    return ShoppingShare.fromPrimitives({
      id: item.id,
      ownerUserId: item.ownerUserId,
      tokenHash: item.tokenHash,
      text: item.text,
      createdAt: new Date(item.createdAt),
      expiresAt: new Date(item.expiresAt),
      revokedAt: item.revokedAt ? new Date(item.revokedAt) : undefined,
      updatedAt: new Date(item.updatedAt),
    });
  }

  private async query<T>(
    input: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName'>,
  ): Promise<T[]> {
    const items: T[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          ...input,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      items.push(...((result.Items ?? []) as T[]));
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey && !input.Limit);

    return items;
  }
}

function shoppingShareKey(tokenHash: string): string {
  return `SHOPPING_SHARE#${tokenHash}`;
}

function shoppingShareByIdKey(id: string): string {
  return `SHOPPING_SHARE_BY_ID#${id}`;
}

function shoppingShareOwnerKey(ownerUserId: string): string {
  return `SHOPPING_SHARE_OWNER#${ownerUserId}`;
}
