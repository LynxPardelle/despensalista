import { ConfigService } from '@nestjs/config';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ProductCategory, QuantityUnit } from '../../../domain/enums';
import { ProductType } from '../../../domain/entities/product-type.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbProductTypeRepository } from './dynamodb-product-type.repository';

describe('DynamoDbProductTypeRepository', () => {
  it('reads active products beyond pages containing archived products', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            ...buildProductTypeItem('archived', 'A'),
            archivedAt: '2026-01-01',
          },
        ],
        LastEvaluatedKey: { id: 'archived' },
      })
      .mockResolvedValueOnce({ Items: [buildProductTypeItem('active', 'B')] });
    const repository = new DynamoDbProductTypeRepository(
      { send } as unknown as DynamoDbDocumentClientService,
      {
        getOrThrow: () => 'types',
        get: () => undefined,
      } as unknown as ConfigService,
    );
    const products = await repository.findByUserId(UserId.fromString('user-1'));
    expect(products.map((product) => product.id.toString())).toEqual([
      'active',
    ]);
  });
  it('serializes price history dates before persisting shopping metadata', async () => {
    let capturedItem: Record<string, unknown> | undefined;
    const dynamoDb = {
      send: jest.fn(async (command: PutCommand | QueryCommand) => {
        if (command instanceof QueryCommand) {
          return { Items: [] };
        }

        capturedItem = command.input.Item as Record<string, unknown>;
        return {};
      }),
    } as unknown as DynamoDbDocumentClientService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('product-types'),
      get: jest.fn(),
    } as unknown as ConfigService;
    const repository = new DynamoDbProductTypeRepository(
      dynamoDb,
      configService,
    );
    const productType = ProductType.create(
      UserId.fromString('user-1'),
      'Arroz',
      ProductCategory.FOOD,
      QuantityUnit.KILOGRAM,
      undefined,
      {
        shoppingLocation: 'Mercado',
        preferredBrand: 'Marca local',
        estimatedUnitPrice: 42,
        householdStaple: true,
        buyOnlyOnPromo: false,
      },
    );

    const saved = await repository.save(productType);

    const metadata = capturedItem?.['shoppingMetadata'] as
      | {
          priceHistory?: Array<{ recordedAt?: unknown }>;
        }
      | undefined;
    expect(metadata?.priceHistory?.[0]?.recordedAt).toEqual(expect.any(String));
    expect(
      Number.isNaN(
        Date.parse(metadata?.priceHistory?.[0]?.recordedAt as string),
      ),
    ).toBe(false);
    expect(
      saved.toPrimitives().shoppingMetadata?.priceHistory?.[0]?.recordedAt,
    ).toBeInstanceOf(Date);
  });

  it('deletes product types across all DynamoDB result pages', async () => {
    const firstItem = buildProductTypeItem('type-1', 'Arroz');
    const secondItem = buildProductTypeItem('type-2', 'Frijol');
    const dynamoDb = {
      send: jest
        .fn()
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.ExclusiveStartKey).toBeUndefined();

          return {
            Items: [firstItem],
            LastEvaluatedKey: { id: firstItem.id },
          };
        })
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.ExclusiveStartKey).toEqual({ id: firstItem.id });

          return { Items: [secondItem] };
        })
        .mockResolvedValue({}),
    } as unknown as DynamoDbDocumentClientService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('product-types'),
      get: jest.fn(),
    } as unknown as ConfigService;
    const repository = new DynamoDbProductTypeRepository(
      dynamoDb,
      configService,
    );

    const deletedCount = await repository.deleteByUserId(
      UserId.fromString('user-1'),
    );

    expect(deletedCount).toBe(2);
    const deleteInputs = (dynamoDb.send as jest.Mock).mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteCommand)
      .map((command: DeleteCommand) => command.input);
    expect(deleteInputs).toEqual([
      expect.objectContaining({ Key: { id: 'type-1' } }),
      expect.objectContaining({ Key: { id: 'type-2' } }),
    ]);
  });

  it('pages archived product types without dropping filtered DynamoDB results', async () => {
    const firstItem = {
      ...buildProductTypeItem('type-1', 'Arroz'),
      archivedAt: '2026-05-20T00:00:00.000Z',
    };
    const secondItem = {
      ...buildProductTypeItem('type-2', 'Frijol'),
      archivedAt: '2026-05-19T00:00:00.000Z',
    };
    const dynamoDb = {
      send: jest
        .fn()
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.Limit).toBe(2);

          return {
            Items: [firstItem],
            LastEvaluatedKey: { id: firstItem.id },
          };
        })
        .mockImplementationOnce(async (command: QueryCommand) => {
          expect(command.input.Limit).toBe(1);
          expect(command.input.ExclusiveStartKey).toEqual({ id: firstItem.id });

          return {
            Items: [secondItem],
            LastEvaluatedKey: { id: secondItem.id },
          };
        }),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbProductTypeRepository(
      dynamoDb,
      makeConfigService('product-types'),
    );

    const page = await repository.findArchivedPageByUserId(
      UserId.fromString('user-1'),
      { limit: 2 },
    );

    expect(page.items.map((item) => item.id.toString())).toEqual([
      'type-1',
      'type-2',
    ]);
    expect(page.nextCursor).toBeDefined();
  });

  it('rejects invalid archived product type cursors before querying DynamoDB', async () => {
    const dynamoDb = {
      send: jest.fn(),
    } as unknown as DynamoDbDocumentClientService;
    const repository = new DynamoDbProductTypeRepository(
      dynamoDb,
      makeConfigService('product-types'),
    );

    await expect(
      repository.findArchivedPageByUserId(UserId.fromString('user-1'), {
        limit: 2,
        cursor: 'bad-cursor',
      }),
    ).rejects.toThrow('Invalid archived product type cursor');
    expect(dynamoDb.send).not.toHaveBeenCalled();
  });
});

function makeConfigService(tableName: string): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue(tableName),
    get: jest.fn(),
  } as unknown as ConfigService;
}

function buildProductTypeItem(id: string, baseName: string) {
  return {
    entityType: 'PRODUCT_TYPE',
    id,
    userId: 'user-1',
    baseName,
    normalizedBaseName: baseName.toLocaleLowerCase('es'),
    category: ProductCategory.FOOD,
    defaultUnit: QuantityUnit.KILOGRAM,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  };
}
