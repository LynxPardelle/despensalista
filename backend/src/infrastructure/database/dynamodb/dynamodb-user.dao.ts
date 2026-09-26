import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import {
  AccountDeletionContext,
  AccountDeletionJob,
  AccountDeletionStartContext,
  UserDao,
} from '../../../application/ports/daos';
import { HouseholdRole } from '../../../domain/entities/household.entity';
import { User, UserPrimitives } from '../../../domain/entities/user.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

type UserItem = Omit<
  UserPrimitives,
  'createdAt' | 'updatedAt' | 'deletionFenceExpiresAt'
> & {
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

type AccountDeletionJobItem = {
  pk: string;
  entityType: 'ACCOUNT_DELETION_JOB';
  gsi2pk: 'ACCOUNT_DELETION_JOBS';
  gsi2sk: string;
  userId: string;
  email: string;
  username: string;
  authSubjectIds: string[];
  pantryDeletionToken: string;
  householdId?: string;
  householdRole?: HouseholdRole;
  startedAt: string;
  nextAttemptAt: string;
  attempts: number;
  leaseToken?: string;
  leaseExpiresAt?: string;
};

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

const ACCOUNT_DELETION_FENCE_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_DELETION_INITIAL_RETRY_DELAY_MS = 2 * 60 * 1000;

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
    context: AccountDeletionStartContext = {},
  ): Promise<AccountDeletionJob | null> {
    const existingJob = await this.findAccountDeletionJob(id);
    if (existingJob) return existingJob;

    const user = await this.findById(id);
    if (!user) return null;

    const primitives = user.toPrimitives();
    const revocations = this.toRevocationItems(primitives, expiresAt);
    const jobItem = this.toAccountDeletionJobItem(primitives, context);
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...this.accountDeletionContextChecks(primitives.id, context),
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
            {
              Put: {
                TableName: this.tableName,
                Item: jobItem,
                ConditionExpression: 'attribute_not_exists(pk)',
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
        const winner = await this.findAccountDeletionJob(id);
        if (winner) return winner;
        throw new ConflictException('Account changed; retry deletion');
      }
      throw error;
    }

    return this.toAccountDeletionJob(jobItem);
  }

  async findPendingAccountDeletions(
    limit: number,
  ): Promise<AccountDeletionJob[]> {
    const result = await this.dynamoDb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'gsi2',
        KeyConditionExpression: 'gsi2pk = :jobs',
        ExpressionAttributeValues: { ':jobs': 'ACCOUNT_DELETION_JOBS' },
        ScanIndexForward: true,
        Limit: Math.min(Math.max(1, Math.trunc(limit)), 10),
      }),
    );

    return ((result.Items ?? []) as AccountDeletionJobItem[])
      .filter((item) => item.entityType === 'ACCOUNT_DELETION_JOB')
      .map((item) => this.toAccountDeletionJob(item));
  }

  async claimPendingAccountDeletion(
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<AccountDeletionJob | null> {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'gsi2',
          KeyConditionExpression: 'gsi2pk = :jobs AND gsi2sk <= :cutoff',
          ExpressionAttributeValues: {
            ':jobs': 'ACCOUNT_DELETION_JOBS',
            ':cutoff': `${now.toISOString()}#\uffff`,
          },
          ScanIndexForward: true,
          Limit: 10,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      for (const item of (result.Items ?? []) as AccountDeletionJobItem[]) {
        const leaseToken = randomUUID();
        try {
          const claimed = await this.dynamoDb.send(
            new UpdateCommand({
              TableName: this.tableName,
              Key: { pk: item.pk },
              UpdateExpression:
                'SET nextAttemptAt = :leaseExpiresAt, gsi2sk = :gsi2sk, leaseToken = :leaseToken, leaseExpiresAt = :leaseExpiresAt',
              ConditionExpression:
                'entityType = :job AND nextAttemptAt <= :now AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)',
              ExpressionAttributeValues: {
                ':job': 'ACCOUNT_DELETION_JOB',
                ':now': now.toISOString(),
                ':leaseToken': leaseToken,
                ':leaseExpiresAt': leaseExpiresAt.toISOString(),
                ':gsi2sk': `${leaseExpiresAt.toISOString()}#${item.startedAt}#${item.userId}`,
              },
              ReturnValues: 'ALL_NEW',
            }),
          );
          if (claimed.Attributes) {
            return this.toAccountDeletionJob(
              claimed.Attributes as AccountDeletionJobItem,
            );
          }
        } catch (error) {
          if ((error as Error).name !== 'ConditionalCheckFailedException') {
            throw error;
          }
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey);
    return null;
  }

  async deferAccountDeletion(
    job: AccountDeletionJob,
    nextAttemptAt: Date,
  ): Promise<void> {
    if (!job.leaseToken) throw new Error('Account deletion lease is required');
    await this.dynamoDb.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: accountDeletionJobKey(job.userId) },
        UpdateExpression:
          'SET nextAttemptAt = :nextAttemptAt, gsi2sk = :gsi2sk, attempts = if_not_exists(attempts, :zero) + :one REMOVE leaseToken, leaseExpiresAt',
        ConditionExpression: 'leaseToken = :leaseToken',
        ExpressionAttributeValues: {
          ':nextAttemptAt': nextAttemptAt.toISOString(),
          ':gsi2sk': `${nextAttemptAt.toISOString()}#${job.startedAt.toISOString()}#${job.userId}`,
          ':zero': 0,
          ':one': 1,
          ':leaseToken': job.leaseToken,
        },
      }),
    );
  }

  async delete(id: UserId): Promise<void> {
    const job = await this.findAccountDeletionJob(id);
    const user = await this.findById(id);
    const primitives = user?.toPrimitives();

    if (!job && !primitives) {
      return;
    }

    const snapshot = job ?? {
      userId: primitives!.id,
      email: primitives!.email,
      username: primitives!.username,
      authSubjectIds: primitives!.authSubjectIds ?? [],
      startedAt: new Date(),
    };
    const lookupKeys = this.getLookupKeys(snapshot);
    const revocations = this.toRevocationItems(
      { id: snapshot.userId, authSubjectIds: snapshot.authSubjectIds },
      new Date(Date.now() + ACCOUNT_DELETION_FENCE_MS),
    );

    await this.dynamoDb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: { pk: userKey(snapshot.userId) },
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
          ...(job
            ? [
                {
                  Delete: {
                    TableName: this.tableName,
                    Key: { pk: pantryQuotaKey(snapshot.userId) },
                    ConditionExpression:
                      'entityType = :pantryQuota AND deleting = :deleting AND deletionToken = :deletionToken',
                    ExpressionAttributeValues: {
                      ':pantryQuota': 'PANTRY_QUOTA',
                      ':deleting': true,
                      ':deletionToken': job.pantryDeletionToken,
                    },
                  },
                },
              ]
            : []),
          {
            Delete: {
              TableName: this.tableName,
              Key: { pk: accountDeletionJobKey(snapshot.userId) },
            },
          },
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

  private async findAccountDeletionJob(
    id: UserId,
  ): Promise<AccountDeletionJob | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        Key: { pk: accountDeletionJobKey(id.toString()) },
      }),
    );
    const item = result.Item as AccountDeletionJobItem | undefined;
    return item?.entityType === 'ACCOUNT_DELETION_JOB'
      ? this.toAccountDeletionJob(item)
      : null;
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
      ...(primitives.deletionFenceExpiresAt
        ? {
            deletionFenceExpiresAt:
              primitives.deletionFenceExpiresAt.toISOString(),
          }
        : {}),
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

  private toAccountDeletionJobItem(
    user: UserPrimitives,
    context: AccountDeletionContext,
  ): AccountDeletionJobItem {
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();
    const nextAttemptAt = new Date(
      startedAtDate.getTime() + ACCOUNT_DELETION_INITIAL_RETRY_DELAY_MS,
    ).toISOString();
    return {
      pk: accountDeletionJobKey(user.id),
      entityType: 'ACCOUNT_DELETION_JOB',
      gsi2pk: 'ACCOUNT_DELETION_JOBS',
      gsi2sk: `${nextAttemptAt}#${startedAt}#${user.id}`,
      userId: user.id,
      email: user.email,
      username: user.username,
      authSubjectIds: normalizeAuthSubjectIds(user.authSubjectIds ?? []),
      pantryDeletionToken: randomUUID(),
      householdId: context.householdId,
      householdRole: context.householdRole,
      startedAt,
      nextAttemptAt,
      attempts: 0,
    };
  }

  private toAccountDeletionJob(
    item: AccountDeletionJobItem,
  ): AccountDeletionJob {
    return {
      userId: item.userId,
      email: item.email,
      username: item.username,
      authSubjectIds: normalizeAuthSubjectIds(item.authSubjectIds ?? []),
      pantryDeletionToken: item.pantryDeletionToken,
      householdId: item.householdId,
      householdRole: item.householdRole,
      startedAt: new Date(item.startedAt),
      attempts: item.attempts ?? 0,
      leaseToken: item.leaseToken,
    };
  }

  private accountDeletionContextChecks(
    userId: string,
    context: AccountDeletionStartContext,
  ): TransactItem[] {
    if (!context.householdId || !context.householdRole) {
      return [
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: { pk: membershipByUserKey(userId) },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ];
    }

    const checks: TransactItem[] = [
      {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { pk: membershipByUserKey(userId) },
          ConditionExpression:
            'householdId = :householdId AND #role = :householdRole',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: {
            ':householdId': context.householdId,
            ':householdRole': context.householdRole,
          },
        },
      },
    ];
    if (context.householdRole === 'owner') {
      if (!context.householdDeletionToken) {
        throw new ConflictException('Household deletion lock was lost; retry');
      }
      checks.push({
        ConditionCheck: {
          TableName: this.tableName,
          Key: { pk: householdKey(context.householdId) },
          ConditionExpression:
            'ownerUserId = :ownerUserId AND deleting = :deleting',
          ExpressionAttributeValues: {
            ':ownerUserId': userId,
            ':deleting': context.householdDeletionToken,
          },
        },
      });
    }
    return checks;
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
      ...(item.deletionFenceExpiresAt
        ? { deletionFenceExpiresAt: new Date(item.deletionFenceExpiresAt) }
        : {}),
    });
  }

  private getLookupKeys(
    primitives: Pick<UserPrimitives, 'email' | 'username' | 'authSubjectIds'>,
  ): string[] {
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

function accountDeletionJobKey(userId: string): string {
  return `ACCOUNT_DELETION_JOB#${userId}`;
}

function pantryQuotaKey(userId: string): string {
  return `PANTRY_QUOTA#${userId}`;
}

function membershipByUserKey(userId: string): string {
  return `HOUSEHOLD_MEMBER_BY_USER#${userId}`;
}

function householdKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
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
