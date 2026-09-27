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

type UserDeviceReservationItem = {
  pk: string;
  entityType: 'USER_DEVICE_RESERVATION';
  userId: string;
  count: number;
};

const MAX_USER_DEVICES_PER_USER = 25;

@Injectable()
export class DynamoDbUserDeviceRepository implements UserDeviceRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async save(device: UserDevice): Promise<UserDevice | null> {
    const item = this.toItem(device.toPrimitives());
    const existing = await this.findItemById(item.id, true);

    if (existing) {
      return this.updateExisting(item);
    }

    const reservation =
      (await this.findReservation(item.userId)) ??
      (await this.initializeReservation(item.userId));

    if (reservation.count >= MAX_USER_DEVICES_PER_USER) {
      return null;
    }

    return this.createNew(item);
  }

  private async updateExisting(item: UserDeviceItem): Promise<UserDevice> {
    const now = new Date().toISOString();

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            this.activeAccountCheck(item.userId, now),
            {
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression:
                  '#entityType = :device AND #userId = :userId',
                ExpressionAttributeNames: {
                  '#entityType': 'entityType',
                  '#userId': 'userId',
                },
                ExpressionAttributeValues: {
                  ':device': 'USER_DEVICE',
                  ':userId': item.userId,
                },
              },
            },
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

  private async createNew(item: UserDeviceItem): Promise<UserDevice | null> {
    const now = new Date().toISOString();

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            this.activeAccountCheck(item.userId, now),
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: reservationKey(item.userId) },
                UpdateExpression: 'ADD #count :one',
                ConditionExpression: '#count < :limit',
                ExpressionAttributeNames: { '#count': 'count' },
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':limit': MAX_USER_DEVICES_PER_USER,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      return this.toDomain(item);
    } catch (error) {
      if ((error as Error).name !== 'TransactionCanceledException') {
        throw error;
      }

      const winner = await this.findItemById(item.id, true);
      if (winner?.userId === item.userId) {
        return this.toDomain(winner);
      }

      const reservation = await this.findReservation(item.userId);
      if (reservation && reservation.count >= MAX_USER_DEVICES_PER_USER) {
        return null;
      }

      throw new UnauthorizedException('Account deletion is in progress');
    }
  }

  private async initializeReservation(
    userId: string,
  ): Promise<UserDeviceReservationItem> {
    const count = (await this.findAllByUserId(UserId.fromString(userId)))
      .length;
    const item: UserDeviceReservationItem = {
      pk: reservationKey(userId),
      entityType: 'USER_DEVICE_RESERVATION',
      userId,
      count,
    };

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            this.activeAccountCheck(userId, new Date().toISOString()),
            {
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      return item;
    } catch (error) {
      if ((error as Error).name !== 'TransactionCanceledException') {
        throw error;
      }

      const winner = await this.findReservation(userId);
      if (winner) return winner;
      throw new UnauthorizedException('Account deletion is in progress');
    }
  }

  private activeAccountCheck(userId: string, now: string) {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: { pk: userKey(userId) },
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
    };
  }

  private async findReservation(
    userId: string,
  ): Promise<UserDeviceReservationItem | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        Key: { pk: reservationKey(userId) },
      }),
    );
    const item = result.Item as UserDeviceReservationItem | undefined;
    return item?.entityType === 'USER_DEVICE_RESERVATION' ? item : null;
  }

  async findById(id: string): Promise<UserDevice | null> {
    const item = await this.findItemById(id, true);
    return item ? this.toDomain(item) : null;
  }

  private async findItemById(
    id: string,
    consistentRead: boolean,
  ): Promise<UserDeviceItem | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        ConsistentRead: consistentRead,
        Key: {
          pk: deviceKey(id),
        },
      }),
    );
    const item = result.Item as UserDeviceItem | undefined;

    return item?.entityType === 'USER_DEVICE' ? item : null;
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
      [
        ...devices.map((device) => deviceKey(device.id)),
        reservationKey(userId.toString()),
      ].map((pk) =>
        this.dynamoDb.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: { pk },
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

function reservationKey(userId: string): string {
  return `USER_DEVICE_RESERVATION#${userId}`;
}

function userDeviceIndexKey(userId: string): string {
  return `USER_DEVICE#${userId}`;
}
