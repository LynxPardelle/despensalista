import { ConfigService } from '@nestjs/config';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbShoppingListRepository } from './dynamodb-shopping-list.repository';

describe('DynamoDbShoppingListRepository', () => {
  it('returns an empty indexed list without scanning the shared table', async () => {
    const dynamoDb = makeIndexedOnlyClient();
    const repository = new DynamoDbShoppingListRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(repository.listByOwnerUserId('user-1')).resolves.toEqual([]);
    expect(dynamoDb.send).toHaveBeenCalledTimes(1);
  });

  it('deletes only indexed owner lists without scanning the shared table', async () => {
    const dynamoDb = makeIndexedOnlyClient();
    const repository = new DynamoDbShoppingListRepository(
      dynamoDb,
      makeConfigService(),
    );

    await expect(
      repository.deleteByOwnerUserId(UserId.fromString('user-1')),
    ).resolves.toBe(0);
    expect(dynamoDb.send).toHaveBeenCalledTimes(1);
  });
});

function makeIndexedOnlyClient(): DynamoDbDocumentClientService & {
  send: jest.Mock;
} {
  return {
    send: jest.fn(async (command: QueryCommand | ScanCommand) => {
      if (command instanceof ScanCommand) {
        throw new Error('request-time table scans are forbidden');
      }

      return { Items: [] };
    }),
  } as unknown as DynamoDbDocumentClientService & { send: jest.Mock };
}

function makeConfigService(): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue('users'),
  } as unknown as ConfigService;
}
