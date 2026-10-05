import { ConfigService } from '@nestjs/config';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbProductRepository } from './dynamodb-product.repository';

describe('DynamoDbProductRepository', () => {
  it('deletes legacy products across every DynamoDB result page', async () => {
    let queryCount = 0;
    const deletedIds: string[] = [];
    const dynamoDb = {
      send: jest.fn(
        async (command: QueryCommand | DeleteCommand): Promise<object> => {
          if (command instanceof QueryCommand) {
            queryCount += 1;

            if (queryCount === 1) {
              expect(command.input.ExclusiveStartKey).toBeUndefined();
              return {
                Items: [{ entityType: 'PRODUCT', id: 'product-1' }],
                LastEvaluatedKey: { id: 'product-1' },
              };
            }

            expect(command.input.ExclusiveStartKey).toEqual({
              id: 'product-1',
            });
            return {
              Items: [{ entityType: 'PRODUCT', id: 'product-2' }],
            };
          }

          deletedIds.push(command.input.Key?.['id'] as string);
          return {};
        },
      ),
    } as unknown as DynamoDbDocumentClientService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('products'),
    } as unknown as ConfigService;
    const repository = new DynamoDbProductRepository(dynamoDb, configService);

    await expect(
      repository.deleteByUserId(UserId.fromString('user-1')),
    ).resolves.toBe(2);
    expect(queryCount).toBe(2);
    expect(deletedIds).toEqual(['product-1', 'product-2']);
  });
});
