import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ShoppingList,
  ShoppingListPrimitives,
} from '../../../domain/entities/shopping-list.entity';
import { ShoppingListRepository } from '../../../domain/repositories/shopping-list.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type ShoppingListItem = Omit<
  ShoppingListPrimitives,
  'createdAt' | 'updatedAt'
> & {
  pk: string;
  entityType: 'SHOPPING_LIST';
  gsi2pk: string;
  gsi2sk: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class DynamoDbShoppingListRepository implements ShoppingListRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async save(list: ShoppingList): Promise<ShoppingList> {
    const item = this.toItem(list.toPrimitives());

    await this.dynamoDb.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );

    return this.toDomain(item);
  }

  async findById(id: string): Promise<ShoppingList | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: shoppingListKey(id) },
      }),
    );

    return result.Item ? this.toDomain(result.Item as ShoppingListItem) : null;
  }

  async listByOwnerUserId(ownerUserId: string): Promise<ShoppingList[]> {
    const indexedItems = await this.query<ShoppingListItem>({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk',
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ':gsi2pk': shoppingListOwnerKey(ownerUserId),
      },
      Limit: 25,
    });

    return indexedItems.map((item) => this.toDomain(item));
  }

  async delete(id: string): Promise<void> {
    await this.dynamoDb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: shoppingListKey(id) },
      }),
    );
  }

  async deleteByOwnerUserId(userId: UserId): Promise<number> {
    const indexedItems = await this.query<ShoppingListItem>({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :gsi2pk',
      ExpressionAttributeValues: {
        ':gsi2pk': shoppingListOwnerKey(userId.toString()),
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

  private toItem(primitives: ShoppingListPrimitives): ShoppingListItem {
    return {
      pk: shoppingListKey(primitives.id),
      entityType: 'SHOPPING_LIST',
      gsi2pk: shoppingListOwnerKey(primitives.ownerUserId),
      gsi2sk: `UPDATED#${primitives.updatedAt.toISOString()}#${primitives.id}`,
      id: primitives.id,
      ownerUserId: primitives.ownerUserId,
      title: primitives.title,
      occasion: primitives.occasion,
      shoppingLocation: primitives.shoppingLocation,
      items: primitives.items,
      createdAt: primitives.createdAt.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
    };
  }

  private toDomain(item: ShoppingListItem): ShoppingList {
    return ShoppingList.fromPrimitives({
      id: item.id,
      ownerUserId: item.ownerUserId,
      title: item.title,
      occasion: item.occasion,
      shoppingLocation: item.shoppingLocation,
      items: item.items,
      createdAt: new Date(item.createdAt),
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

function shoppingListKey(id: string): string {
  return `SHOPPING_LIST#${id}`;
}

function shoppingListOwnerKey(ownerUserId: string): string {
  return `SHOPPING_LIST_OWNER#${ownerUserId}`;
}
