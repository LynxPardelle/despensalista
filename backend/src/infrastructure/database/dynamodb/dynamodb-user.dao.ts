import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { UserDao } from '../../../application/ports/daos';
import { User, UserPrimitives } from '../../../domain/entities/user.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type UserItem = Omit<UserPrimitives, 'createdAt' | 'updatedAt'> & {
  pk: string;
  entityType: 'USER';
  normalizedEmail: string;
  normalizedUsername: string;
  createdAt: string;
  updatedAt: string;
  deletionFenceExpiresAt?: string;
};

type UserLookupItem = {
  pk: string;
  entityType: 'USER_LOOKUP';
  userId: string;
};

type AccountRevocationItem = {
  pk: string;
  entityType: 'ACCOUNT_REVOCATION';
  expiresAt: string;
  expiresAtEpochSeconds: number;
};

const ACCOUNT_DELETION_FENCE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DynamoDbUserDao implements UserDao {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async save(user: User): Promise<User> {
    const primitives = user.toPrimitives();
    const existingUser = await this.findById(UserId.fromString(primitives.id));
    const existingPrimitives = existingUser?.toPrimitives();
    const normalizedEmail = normalizeEmail(primitives.email);
    const normalizedUsername = normalizeUsername(primitives.username);
    const userItem = this.toUserItem(primitives);
    const lookupItems = [
      this.toLookupItem(emailKey(normalizedEmail), primitives.id),
      this.toLookupItem(usernameKey(normalizedUsername), primitives.id),
      ...normalizeAuthSubjectIds(primitives.authSubjectIds ?? []).map(
        (authSubjectId) =>
          this.toLookupItem(authSubjectKey(authSubjectId), primitives.id),
      ),
    ];
    const staleLookupKeys = this.getStaleLookupKeys(
      existingPrimitives,
      primitives,
    );
    const revocations = this.toRevocationItems(
      primitives,
      new Date(Date.now() + ACCOUNT_DELETION_FENCE_MS),
    );

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: userItem,
              },
            },
            ...lookupItems.map((item) => ({
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression:
                  'attribute_not_exists(pk) OR userId = :userId',
                ExpressionAttributeValues: {
                  ':userId': primitives.id,
                },
              },
            })),
            ...staleLookupKeys.map((key) => ({
              Delete: {
                TableName: this.tableName,
                Key: { pk: key },
              },
            })),
            ...revocations.map((revocation) => ({
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: revocation.pk },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            })),
          ],
        }),
      );
    } catch (error) {
      if (
        (error as Error).name === 'TransactionCanceledException' &&
        (await this.hasRevocation(revocations))
      ) {
        throw accountDeletedError();
      }
      throw error;
    }

    return this.toDomain(userItem);
  }

  async findById(id: UserId): Promise<User | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        Key: {
          pk: userKey(id.toString()),
        },
      }),
    );

    return result.Item ? this.toDomain(result.Item as UserItem) : null;
  }

  async findByAuthSubject(authSubjectId: string): Promise<User | null> {
    return this.findByLookup(
      authSubjectKey(normalizeAuthSubjectId(authSubjectId)),
    );
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.findByLookup(emailKey(normalizeEmail(email)));
  }

  async findByUsername(username: string): Promise<User | null> {
    return this.findByLookup(usernameKey(normalizeUsername(username)));
  }

  async beginAccountDeletion(
    id: UserId,
    expiresAt: Date,
  ): Promise<User | null> {
    const user = await this.findById(id);
    if (!user) return null;

    const primitives = user.toPrimitives();
    const revocations = this.toRevocationItems(primitives, expiresAt);
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { pk: userKey(primitives.id) },
                UpdateExpression:
                  'SET deletionFenceExpiresAt = :deletionFenceExpiresAt',
                ConditionExpression: 'updatedAt = :updatedAt',
                ExpressionAttributeValues: {
                  ':deletionFenceExpiresAt': expiresAt.toISOString(),
                  ':updatedAt': primitives.updatedAt.toISOString(),
                },
              },
            },
            ...revocations.map((revocation) => ({
              Put: {
                TableName: this.tableName,
                Item: revocation,
              },
            })),
          ],
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'TransactionCanceledException') {
        throw new ConflictException('Account changed; retry deletion');
      }
      throw error;
    }

    return user;
  }

  async delete(id: UserId): Promise<void> {
    const user = await this.findById(id);
    const primitives = user?.toPrimitives();

    if (!primitives) {
      return;
    }

    const lookupKeys = this.getLookupKeys(primitives);
    const revocations = this.toRevocationItems(
      primitives,
      new Date(Date.now() + ACCOUNT_DELETION_FENCE_MS),
    );

    await this.dynamoDb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: { pk: userKey(id.toString()) },
            },
          },
          ...lookupKeys.map((key) => ({
            Delete: {
              TableName: this.tableName,
              Key: { pk: key },
            },
          })),
          ...revocations.map((revocation) => ({
            Put: {
              TableName: this.tableName,
              Item: revocation,
            },
          })),
        ],
      }),
    );
  }

  private async hasRevocation(
    revocations: AccountRevocationItem[],
  ): Promise<boolean> {
    const results = await Promise.all(
      revocations.map((revocation) =>
        this.dynamoDb.send(
          new GetCommand({
            TableName: this.tableName,
            ConsistentRead: true,
            Key: { pk: revocation.pk },
          }),
        ),
      ),
    );
    return results.some((result) => Boolean(result.Item));
  }

  private async findByLookup(lookupPk: string): Promise<User | null> {
    const lookupResult = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: lookupPk },
      }),
    );
    const lookup = lookupResult.Item as UserLookupItem | undefined;

    if (!lookup?.userId) {
      return null;
    }

    return this.findById(UserId.fromString(lookup.userId));
  }

  private toUserItem(primitives: UserPrimitives): UserItem {
    return {
      pk: userKey(primitives.id),
      entityType: 'USER',
      id: primitives.id,
      email: primitives.email,
      username: primitives.username,
      authSubjectIds: normalizeAuthSubjectIds(primitives.authSubjectIds ?? []),
      status: primitives.status,
      normalizedEmail: normalizeEmail(primitives.email),
      normalizedUsername: normalizeUsername(primitives.username),
      createdAt: primitives.createdAt.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
    };
  }

  private toLookupItem(pk: string, userId: string): UserLookupItem {
    return {
      pk,
      entityType: 'USER_LOOKUP',
      userId,
    };
  }

  private toRevocationItems(
    user: Pick<UserPrimitives, 'id' | 'authSubjectIds'>,
    expiresAt: Date,
  ): AccountRevocationItem[] {
    return [...new Set([user.id, ...(user.authSubjectIds ?? [])])].map(
      (principalId) => ({
        pk: accountRevocationKey(principalId),
        entityType: 'ACCOUNT_REVOCATION',
        expiresAt: expiresAt.toISOString(),
        expiresAtEpochSeconds: Math.floor(expiresAt.getTime() / 1000),
      }),
    );
  }

  private toDomain(item: UserItem): User {
    return User.fromPrimitives({
      id: item.id,
      email: item.email,
      username: item.username,
      authSubjectIds: item.authSubjectIds ?? [],
      status: item.status,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    });
  }

  private getLookupKeys(primitives: UserPrimitives): string[] {
    return [
      emailKey(normalizeEmail(primitives.email)),
      usernameKey(normalizeUsername(primitives.username)),
      ...normalizeAuthSubjectIds(primitives.authSubjectIds ?? []).map(
        authSubjectKey,
      ),
    ];
  }

  private getStaleLookupKeys(
    existing: UserPrimitives | undefined,
    next: UserPrimitives,
  ): string[] {
    if (!existing) {
      return [];
    }

    const nextKeys = new Set(this.getLookupKeys(next));

    return this.getLookupKeys(existing).filter((key) => !nextKeys.has(key));
  }
}

function userKey(id: string): string {
  return `USER#${id}`;
}

function emailKey(email: string): string {
  return `EMAIL#${email}`;
}

function usernameKey(username: string): string {
  return `USERNAME#${username}`;
}

function authSubjectKey(authSubjectId: string): string {
  return `AUTH#${authSubjectId}`;
}

function accountRevocationKey(principalId: string): string {
  const digest = createHash('sha256').update(principalId.trim()).digest('hex');
  return `ACCOUNT_REVOCATION#${digest}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase('en-US');
}

function normalizeUsername(username: string): string {
  return username.trim().toLocaleLowerCase('es');
}

function normalizeAuthSubjectId(authSubjectId: string): string {
  return authSubjectId.trim();
}

function normalizeAuthSubjectIds(authSubjectIds: string[]): string[] {
  return [...new Set(authSubjectIds.map(normalizeAuthSubjectId))];
}

function accountDeletedError(): UnauthorizedException {
  return new UnauthorizedException('Account deletion is in progress');
}
