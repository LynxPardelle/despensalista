import { ConfigService } from '@nestjs/config';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserPreferences } from '../../../domain/value-objects/user-preferences.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';
import { DynamoDbUserPreferencesDao } from './dynamodb-user-preferences.dao';

describe('DynamoDbUserPreferencesDao account fence', () => {
  it('updates only an existing active unfenced user row', async () => {
    const dynamo = {
      send: jest.fn().mockResolvedValue({
        Attributes: { preferences: UserPreferences.resolve().toPrimitives() },
      }),
    } as unknown as DynamoDbDocumentClientService;
    const dao = new DynamoDbUserPreferencesDao(dynamo, makeConfig());

    await dao.save(UserId.fromString('user-1'), UserPreferences.resolve());

    const command = (dynamo.send as jest.Mock).mock
      .calls[0][0] as UpdateCommand;
    expect(command.input.ConditionExpression).toContain('entityType = :user');
    expect(command.input.ConditionExpression).toContain(
      'deletionFenceExpiresAt',
    );
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ':user': 'USER',
      ':active': 'active',
    });
  });

  it('rejects a delayed preference write once account deletion is fenced', async () => {
    const dynamo = {
      send: jest.fn().mockRejectedValue(
        Object.assign(new Error('fenced'), {
          name: 'ConditionalCheckFailedException',
        }),
      ),
    } as unknown as DynamoDbDocumentClientService;
    const dao = new DynamoDbUserPreferencesDao(dynamo, makeConfig());

    await expect(
      dao.save(UserId.fromString('user-1'), UserPreferences.resolve()),
    ).rejects.toThrow('deletion is in progress');
  });
});

function makeConfig(): ConfigService {
  return {
    getOrThrow: jest.fn().mockReturnValue('users'),
  } as unknown as ConfigService;
}
