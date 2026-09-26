import { ConfigService } from '@nestjs/config';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbWasteEventRepository } from './dynamodb-waste-event.repository';

describe('DynamoDbWasteEventRepository', () => {
  it('deletes more than 1,000 waste events without truncating result pages', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      entityType: 'WASTE_EVENT',
      id: `event-${index}`,
      updatedAt: '2026-08-31T00:00:00.000Z',
    }));
    const deletedIds: string[] = [];
    let queryCount = 0;
    const dynamoDb = {
      send: jest.fn(
        async (command: QueryCommand | DeleteCommand): Promise<object> => {
          if (command instanceof QueryCommand) {
            queryCount += 1;

            if (queryCount === 1) {
              expect(command.input.ExclusiveStartKey).toBeUndefined();
              return {
                Items: firstPage,
                LastEvaluatedKey: { id: 'event-999' },
              };
            }

            expect(command.input.ExclusiveStartKey).toEqual({
              id: 'event-999',
            });
            return {
              Items: [
                {
                  entityType: 'WASTE_EVENT',
                  id: 'event-1000',
                  updatedAt: '2026-08-31T00:00:00.000Z',
                },
              ],
            };
          }

          deletedIds.push(command.input.Key?.['id'] as string);
          return {};
        },
      ),
    } as unknown as DynamoDbDocumentClientService;
    const configService = {
      getOrThrow: jest.fn().mockReturnValue('inventory-lots'),
    } as unknown as ConfigService;
    const repository = new DynamoDbWasteEventRepository(
      dynamoDb,
      configService,
    );

    await expect(
      repository.deleteByUserId(UserId.fromString('user-1')),
    ).resolves.toBe(1001);
    expect(queryCount).toBe(2);
    expect(deletedIds).toHaveLength(1001);
    expect(deletedIds).toContain('event-1000');
  });
});
