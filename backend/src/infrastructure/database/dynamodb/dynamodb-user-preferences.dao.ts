import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  UpdateCommand,
  UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { UserPreferencesDao } from '../../../application/ports/daos';
import {
  UserPreferences,
  UserPreferencesPatch,
  UserPreferencesPrimitives,
} from '../../../domain/value-objects/user-preferences.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type UserPreferencesProjection = {
  preferences?: Partial<UserPreferencesPrimitives>;
};

@Injectable()
export class DynamoDbUserPreferencesDao implements UserPreferencesDao {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async findByUserId(userId: UserId): Promise<UserPreferences> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: userKey(userId.toString()),
        },
        ProjectionExpression: 'preferences',
      }),
    );
    const item = result.Item as UserPreferencesProjection | undefined;

    return UserPreferences.resolve(item?.preferences);
  }

  async save(
    userId: UserId,
    preferences: UserPreferences | UserPreferencesPatch,
  ): Promise<UserPreferences> {
    const resolvedPreferences =
      preferences instanceof UserPreferences
        ? preferences
        : UserPreferences.resolve(preferences);

    const now = new Date().toISOString();
    let result: UpdateCommandOutput;
    try {
      result = await this.dynamoDb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            pk: userKey(userId.toString()),
          },
          UpdateExpression:
            'SET preferences = :preferences, updatedAt = :updatedAt',
          ConditionExpression:
            '#entityType = :user AND #status = :active AND (attribute_not_exists(deletionFenceExpiresAt) OR deletionFenceExpiresAt <= :now)',
          ExpressionAttributeNames: {
            '#entityType': 'entityType',
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':preferences': resolvedPreferences.toPrimitives(),
            ':updatedAt': now,
            ':now': now,
            ':user': 'USER',
            ':active': 'active',
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException') {
        throw accountDeletedError();
      }
      throw error;
    }
    const item = result.Attributes as UserPreferencesProjection | undefined;

    return UserPreferences.resolve(item?.preferences);
  }
}

function accountDeletedError(): UnauthorizedException {
  return new UnauthorizedException('Account deletion is in progress');
}

function userKey(id: string): string {
  return `USER#${id}`;
}
