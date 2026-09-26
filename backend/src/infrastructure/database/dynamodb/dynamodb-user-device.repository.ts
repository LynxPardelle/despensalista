import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  UserDevice,
  UserDevicePrimitives,
} from '../../../domain/entities/user-device.entity';
import { UserDeviceRepository } from '../../../domain/repositories/user-device.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type UserDeviceItem = Omit<
  UserDevicePrimitives,
  'firstSeenAt' | 'lastSeenAt'
> & {
  pk: string;
  entityType: 'USER_DEVICE';
  gsi1pk: string;
  gsi1sk: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

@Injectable()
export class DynamoDbUserDeviceRepository implements UserDeviceRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async save(device: UserDevice): Promise<UserDevice> {
    const item = this.toItem(device.toPrimitives());

    const now = new Date().toISOString();
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: userKey(device.userId.toString()) },
                ConditionExpression:
                  '#entityType = :user AND #status = :active AND (attribute_not_exists(deletionFenceExpiresAt) OR deletionFenceExpiresAt <= :now)',
                ExpressionAttributeNames: {
                  '#entityType': 'entityType',
                  '#status': 'status',
                },
                ExpressionAttributeValues: {
                  ':user': 'USER',
                  ':active': 'active',
                  ':now': now,
                },
              },
            },
            { Put: { TableName: this.tableName, Item: item } },
          ],
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'TransactionCanceledException') {
        throw new UnauthorizedException('Account deletion is in progress');
      }
      throw error;
    }

    return this.toDomain(item);
  }

  async findById(id: string): Promise<UserDevice | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: deviceKey(id),
        },
      }),
    );
    const item = result.Item as UserDeviceItem | undefined;

    return item?.entityType === 'USER_DEVICE' ? this.toDomain(item) : null;
  }

  async findByUserId(userId: UserId, limit = 10): Promise<UserDevice[]> {
    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :gsi1pk',
        ExpressionAttributeValues: {
          ':gsi1pk': userDeviceIndexKey(userId.toString()),
        },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(1, Math.trunc(limit)), 25),
      }),
    );

    return ((result.Items ?? []) as UserDeviceItem[])
      .filter((item) => item.entityType === 'USER_DEVICE')
      .map((item) => this.toDomain(item));
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    const devices = await this.findAllByUserId(userId);

    await Promise.all(
      devices.map((device) =>
        this.dynamoDb.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: {
              pk: deviceKey(device.id),
            },
          }),
        ),
      ),
    );

    return devices.length;
  }

  private async findAllByUserId(userId: UserId): Promise<UserDevice[]> {
    const items: UserDeviceItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      // ponytail: O(shared users table) preserves privacy today; keep device IDs in a
      // transactionally maintained per-user manifest before table growth.
      const result = await this.dynamoDb.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression: 'entityType = :entityType AND userId = :userId',
          ExpressionAttributeValues: {
            ':entityType': 'USER_DEVICE',
            ':userId': userId.toString(),
          },
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      items.push(
        ...((result.Items ?? []) as UserDeviceItem[]).filter(
          (item) =>
            item.entityType === 'USER_DEVICE' &&
            item.userId === userId.toString(),
        ),
      );
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);

    return items.map((item) => this.toDomain(item));
  }

  private toItem(primitives: UserDevicePrimitives): UserDeviceItem {
    return {
      pk: deviceKey(primitives.id),
      entityType: 'USER_DEVICE',
      gsi1pk: userDeviceIndexKey(primitives.userId),
      gsi1sk: primitives.lastSeenAt.toISOString(),
      id: primitives.id,
      userId: primitives.userId,
      label: primitives.label,
      userAgentSummary: primitives.userAgentSummary,
      firstSeenAt: primitives.firstSeenAt.toISOString(),
      lastSeenAt: primitives.lastSeenAt.toISOString(),
      seenCount: primitives.seenCount,
    };
  }

  private toDomain(item: UserDeviceItem): UserDevice {
    return UserDevice.fromPrimitives({
      id: item.id,
      userId: item.userId,
      label: item.label,
      userAgentSummary: item.userAgentSummary,
      firstSeenAt: new Date(item.firstSeenAt),
      lastSeenAt: new Date(item.lastSeenAt),
      seenCount: item.seenCount,
    });
  }
}

function deviceKey(id: string): string {
  return `USER_DEVICE#${id}`;
}

function userKey(id: string): string {
  return `USER#${id}`;
}

function userDeviceIndexKey(userId: string): string {
  return `USER_DEVICE#${userId}`;
}
