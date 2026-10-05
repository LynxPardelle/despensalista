import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  Product,
  ProductPrimitives,
} from '../../../domain/entities/product.entity';
import { ProductCategory, ProductStatus } from '../../../domain/enums';
import {
  ProductFilter,
  ProductRepository,
} from '../../../domain/repositories/product.repository';
import { ProductId } from '../../../domain/value-objects/product-id.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type ProductItem = Omit<
  ProductPrimitives,
  'nextPurchaseDate' | 'createdAt' | 'updatedAt'
> & {
  entityType: 'PRODUCT';
  nextPurchaseDate?: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class DynamoDbProductRepository implements ProductRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>(
      'DYNAMODB_PRODUCTS_TABLE',
    );
  }

  async findById(id: ProductId): Promise<Product | null> {
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
    const items = (result.Items ?? []) as ProductItem[];
    const item = items[0];

    return item ? this.toDomain(item) : null;
  }

  async findByUserId(userId: UserId): Promise<Product[]> {
    return this.findAll({ userId: userId.toString() });
  }

  async findByCategory(category: ProductCategory): Promise<Product[]> {
    return this.findAll({ category });
  }

  async findByStatus(status: ProductStatus): Promise<Product[]> {
    return this.findAll({ status });
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
      const items = (result.Items ?? []) as Array<Pick<ProductItem, 'id'>>;

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

  async findAll(filter?: ProductFilter): Promise<Product[]> {
    if (filter?.userId && !filter.category && !filter.status) {
      return this.findAllByUserId(UserId.fromString(filter.userId));
    }

    const result = await this.dynamoDb.send(
      new ScanCommand({
        TableName: this.tableName,
      }),
    );

    const items = (result.Items ?? []) as ProductItem[];

    return items
      .map((item) => this.toDomain(item))
      .filter((product) => matchesFilter(product, filter))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  private async findAllByUserId(userId: UserId): Promise<Product[]> {
    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'UserUpdatedAtIndex',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId.toString(),
        },
        ScanIndexForward: false,
      }),
    );

    const items = (result.Items ?? []) as ProductItem[];

    return items.map((item) => this.toDomain(item));
  }

  private toDomain(item: ProductItem): Product {
    return Product.fromPrimitives({
      id: item.id,
      userId: item.userId,
      title: item.title,
      currentQuantity: item.currentQuantity,
      unit: item.unit,
      usageRate: item.usageRate,
      category: item.category,
      status: item.status,
      nextPurchaseDate: item.nextPurchaseDate
        ? new Date(item.nextPurchaseDate)
        : undefined,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    });
  }
}

function matchesFilter(product: Product, filter?: ProductFilter): boolean {
  if (!filter) {
    return true;
  }

  if (filter.userId && product.userId.toString() !== filter.userId) {
    return false;
  }

  if (filter.category && product.category !== filter.category) {
    return false;
  }

  if (filter.status && product.status !== filter.status) {
    return false;
  }

  return true;
}
