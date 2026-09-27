import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  Household,
  HouseholdActivity,
  HouseholdActivityPrimitives,
  HouseholdInvite,
  HouseholdInvitePrimitives,
  HouseholdMembership,
  HouseholdMembershipPrimitives,
  HouseholdPrimitives,
} from '../../../domain/entities/household.entity';
import {
  HouseholdDeletionLock,
  HouseholdRepository,
} from '../../../domain/repositories/household.repository';
import { DynamoDbDocumentClientService } from './dynamodb-document-client.service';

const ANONYMIZED_USER_ID = 'deleted-user';
const ANONYMIZED_EMAIL = 'deleted@example.invalid';
const ANONYMIZED_LABEL = 'Usuario eliminado';
const HOUSEHOLD_UNLOCK_MAX_ATTEMPTS = 3;

type TransactItem = NonNullable<
  ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
>[number];

type HouseholdItem = Omit<HouseholdPrimitives, 'createdAt' | 'updatedAt'> & {
  pk: string;
  entityType: 'HOUSEHOLD';
  gsi2pk: string;
  gsi2sk: string;
  createdAt: string;
  updatedAt: string;
};

type MembershipItem = Omit<
  HouseholdMembershipPrimitives,
  'joinedAt' | 'updatedAt'
> & {
  pk: string;
  entityType: 'HOUSEHOLD_MEMBERSHIP';
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
};

type InviteItem = Omit<
  HouseholdInvitePrimitives,
  'createdAt' | 'expiresAt' | 'acceptedAt' | 'revokedAt' | 'updatedAt'
> & {
  pk: string;
  entityType: 'HOUSEHOLD_INVITE';
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  updatedAt: string;
  expiresAtEpochSeconds: number;
};

type ActivityItem = Omit<HouseholdActivityPrimitives, 'createdAt'> & {
  pk: string;
  entityType: 'HOUSEHOLD_ACTIVITY';
  gsi2pk: string;
  gsi2sk: string;
  createdAt: string;
};

@Injectable()
export class DynamoDbHouseholdRepository implements HouseholdRepository {
  private readonly tableName: string;

  constructor(
    private readonly dynamoDb: DynamoDbDocumentClientService,
    configService: ConfigService,
  ) {
    this.tableName = configService.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }

  async createHouseholdWithOwner(
    household: Household,
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership> {
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...this.activeUserChecks([membership.userId]),
            {
              Put: {
                TableName: this.tableName,
                Item: this.toHouseholdItem(household),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: this.toMembershipItem(membership),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: this.toActivityItem(
                  HouseholdActivity.create({
                    householdId: household.id,
                    actorUserId: membership.userId,
                    type: 'household_created',
                  }),
                ),
              },
            },
          ],
        }),
      );
      return membership;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'TransactionCanceledException'
      )
        throw error;
      const winner = await this.findMembershipByUserId(membership.userId);
      if (winner) return winner;
      throw new ConflictException('Household changed; refresh and retry');
    }
  }

  async acceptInvite(
    invite: HouseholdInvite,
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership> {
    const item = this.toInviteItem(invite);
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...this.activeUserChecks([membership.userId, item.invitedByUserId]),
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: householdKey(invite.householdId) },
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(deleting)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: this.toMembershipItem(membership),
                ConditionExpression:
                  'attribute_not_exists(pk) OR (householdId = :household AND #role = :role)',
                ExpressionAttributeNames: { '#role': 'role' },
                ExpressionAttributeValues: {
                  ':household': membership.householdId,
                  ':role': membership.role,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression:
                  'tokenHash = :hash AND expiresAt > :now AND attribute_not_exists(acceptedAt) AND attribute_not_exists(revokedAt)',
                ExpressionAttributeValues: {
                  ':hash': item.tokenHash,
                  ':now': new Date().toISOString(),
                },
              },
            },
          ],
        }),
      );
      return membership;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'TransactionCanceledException'
      )
        throw error;
      throw new ConflictException(
        'Invitation or household membership changed; refresh and retry',
      );
    }
  }

  async saveHousehold(household: Household): Promise<Household> {
    const item = this.toHouseholdItem(household);

    await this.dynamoDb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...this.activeUserChecks([household.ownerUserId]),
          { Put: { TableName: this.tableName, Item: item } },
        ],
      }),
    );

    return this.toHousehold(item);
  }

  async saveMembership(
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership> {
    const item = this.toMembershipItem(membership);

    await this.dynamoDb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...this.activeUserChecks([membership.userId]),
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: { pk: householdKey(membership.householdId) },
              ConditionExpression:
                'attribute_exists(pk) AND attribute_not_exists(deleting)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: item,
              ConditionExpression:
                'attribute_not_exists(pk) OR householdId = :household',
              ExpressionAttributeValues: {
                ':household': membership.householdId,
              },
            },
          },
        ],
      }),
    );

    return this.toMembership(item);
  }

  async saveInvite(invite: HouseholdInvite): Promise<HouseholdInvite> {
    const item = this.toInviteItem(invite);
    const invitedUser = await this.findUserLookup(item.invitedEmail);

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...this.activeUserChecks([
              item.invitedByUserId,
              invitedUser?.userId,
            ]),
            ...(invitedUser
              ? [
                  {
                    ConditionCheck: {
                      TableName: this.tableName,
                      Key: { pk: emailKey(item.invitedEmail) },
                      ConditionExpression: 'userId = :expectedUserId',
                      ExpressionAttributeValues: {
                        ':expectedUserId': invitedUser.userId,
                      },
                    },
                  } satisfies TransactItem,
                ]
              : []),
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: householdKey(invite.householdId) },
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(deleting)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: item,
                ConditionExpression: item.revokedAt
                  ? 'attribute_exists(pk) AND attribute_not_exists(acceptedAt) AND attribute_not_exists(privacyRedacted)'
                  : 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'TransactionCanceledException'
      )
        throw error;
      throw new ConflictException('Invitation changed; refresh and retry');
    }

    return this.toInvite(item);
  }

  async saveActivity(activity: HouseholdActivity): Promise<HouseholdActivity> {
    const item = this.toActivityItem(activity);

    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...this.activeUserChecks([item.actorUserId, item.targetUserId]),
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: householdKey(activity.householdId) },
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(deleting)',
              },
            },
            { Put: { TableName: this.tableName, Item: item } },
          ],
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'TransactionCanceledException'
      )
        throw error;
      // A concurrent household deletion also removes its activity stream.
    }

    return this.toActivity(item);
  }

  async findHouseholdById(id: string): Promise<Household | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: householdKey(id) },
        ConsistentRead: true,
      }),
    );

    return result.Item && !result.Item.deleting
      ? this.toHousehold(result.Item as HouseholdItem)
      : null;
  }

  async findMembershipByUserId(
    userId: string,
  ): Promise<HouseholdMembership | null> {
    const canonical = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: membershipByUserKey(userId) },
        ConsistentRead: true,
      }),
    );
    if (canonical.Item)
      return this.toMembership(canonical.Item as MembershipItem);
    const [item] = await this.query<MembershipItem>({
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk',
      ExpressionAttributeValues: {
        ':gsi1pk': membershipByUserKey(userId),
      },
      Limit: 1,
    });

    if (!item) return null;
    // Migrate an existing legacy key atomically; never recreate a removed membership from a stale GSI.
    if (item.pk === membershipByUserKey(userId)) return null;
    try {
      await this.dynamoDb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...this.activeUserChecks([item.userId]),
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: householdKey(item.householdId) },
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(deleting)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...item, pk: membershipByUserKey(userId) },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: { pk: item.pk },
                ConditionExpression: 'updatedAt = :expected',
                ExpressionAttributeValues: { ':expected': item.updatedAt },
              },
            },
          ],
        }),
      );
      return this.toMembership(item);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'TransactionCanceledException'
      )
        throw error;
      const winner = await this.dynamoDb.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: membershipByUserKey(userId) },
          ConsistentRead: true,
        }),
      );
      if (winner.Item) return this.toMembership(winner.Item as MembershipItem);
      // Closing blocks migration, but must not look like "no membership" and
      // cause first-access code to create another household for a legacy user.
      const legacy = await this.dynamoDb.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: item.pk },
          ConsistentRead: true,
        }),
      );
      return legacy.Item
        ? this.toMembership(legacy.Item as MembershipItem)
        : null;
    }
  }

  async findMembershipByHouseholdAndUserId(
    householdId: string,
    userId: string,
  ): Promise<HouseholdMembership | null> {
    const membership = await this.findMembershipByUserId(userId);
    return membership?.householdId === householdId ? membership : null;
  }

  async findMembersByHouseholdId(
    householdId: string,
  ): Promise<HouseholdMembership[]> {
    const items = await this.query<MembershipItem>({
      IndexName: 'gsi2',
      KeyConditionExpression:
        'gsi2pk = :gsi2pk AND begins_with(gsi2sk, :memberPrefix)',
      ExpressionAttributeValues: {
        ':gsi2pk': householdRecordsKey(householdId),
        ':memberPrefix': 'MEMBER#',
      },
    });

    return items.map((item) => this.toMembership(item));
  }

  async deleteMembership(householdId: string, userId: string): Promise<void> {
    await this.dynamoDb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: membershipByUserKey(userId) },
        ConditionExpression:
          'attribute_not_exists(pk) OR householdId = :household',
        ExpressionAttributeValues: { ':household': householdId },
      }),
    );
  }

  async findActiveInvitesByHouseholdId(
    householdId: string,
    now: Date,
  ): Promise<HouseholdInvite[]> {
    const items = await this.query<InviteItem>({
      IndexName: 'gsi2',
      KeyConditionExpression:
        'gsi2pk = :gsi2pk AND begins_with(gsi2sk, :invitePrefix)',
      ScanIndexForward: false,
      ExpressionAttributeValues: {
        ':gsi2pk': householdRecordsKey(householdId),
        ':invitePrefix': 'INVITE#',
      },
    });

    const indexedInvites = items
      .map((item) => this.toInvite(item))
      .filter((invite) => invite.isActive(now))
      .slice(0, 25);

    return indexedInvites;
  }

  async findInviteById(id: string): Promise<HouseholdInvite | null> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: inviteKey(id) },
      }),
    );

    return result.Item ? this.toInvite(result.Item as InviteItem) : null;
  }

  async findInviteByTokenHash(
    tokenHash: string,
  ): Promise<HouseholdInvite | null> {
    const [item] = await this.query<InviteItem>({
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk',
      ExpressionAttributeValues: {
        ':gsi1pk': inviteByTokenKey(tokenHash),
      },
      Limit: 1,
    });

    return item ? this.toInvite(item) : null;
  }

  async findActivitiesByHouseholdId(
    householdId: string,
    limit: number,
  ): Promise<HouseholdActivity[]> {
    const items = await this.query<ActivityItem>({
      IndexName: 'gsi2',
      KeyConditionExpression:
        'gsi2pk = :gsi2pk AND begins_with(gsi2sk, :activityPrefix)',
      ScanIndexForward: false,
      Limit: limit,
      ExpressionAttributeValues: {
        ':gsi2pk': householdRecordsKey(householdId),
        ':activityPrefix': 'ACTIVITY#',
      },
    });

    return items.map((item) => this.toActivity(item));
  }

  async deleteAccountHouseholdReferences(
    userId: string,
    email: string,
  ): Promise<void> {
    const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
    let cursor: Record<string, unknown> | undefined;

    do {
      // ponytail: O(shared users table) is the current privacy-safe ceiling;
      // migrate household children to an owner base partition/strong manifest before table growth.
      const page = await this.dynamoDb.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression:
            '(entityType = :activity AND (actorUserId = :user OR targetUserId = :user)) OR (entityType = :invite AND (invitedByUserId = :user OR invitedEmail = :email)) OR (entityType = :membership AND userId = :user)',
          ExpressionAttributeValues: {
            ':activity': 'HOUSEHOLD_ACTIVITY',
            ':invite': 'HOUSEHOLD_INVITE',
            ':membership': 'HOUSEHOLD_MEMBERSHIP',
            ':user': userId,
            ':email': normalizedEmail,
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      const changes = (page.Items ?? []).map((item) =>
        this.accountDeletionChange(item, userId, normalizedEmail),
      );
      for (let offset = 0; offset < changes.length; offset += 100) {
        await this.dynamoDb.send(
          new TransactWriteCommand({
            TransactItems: changes.slice(offset, offset + 100),
          }),
        );
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
  }

  async beginHouseholdDeletion(
    householdId: string,
    ownerUserId: string,
  ): Promise<HouseholdDeletionLock> {
    const token = randomUUID();
    let parentLocked = true;
    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: householdKey(householdId) },
          UpdateExpression: 'SET deleting = :token',
          ConditionExpression: 'ownerUserId = :owner',
          ExpressionAttributeValues: { ':token': token, ':owner': ownerUserId },
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException') {
        const parent = await this.dynamoDb.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: householdKey(householdId) },
            ConsistentRead: true,
          }),
        );
        if (parent.Item)
          throw new ConflictException('Household changed; refresh and retry');
        parentLocked = false;
      } else {
        throw error;
      }
    }
    let cursor: Record<string, unknown> | undefined;
    do {
      // Acceptance/migration now cannot add or move member records. A GSI is
      // unsuitable here because an omitted recent member would permit data loss.
      // ponytail: O(shared users table); add a transactionally maintained member manifest before growth.
      const page = await this.dynamoDb.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression:
            'entityType = :member AND householdId = :household AND userId <> :owner',
          ExpressionAttributeValues: {
            ':member': 'HOUSEHOLD_MEMBERSHIP',
            ':household': householdId,
            ':owner': ownerUserId,
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      if (page.Items?.length) {
        try {
          await this.dynamoDb.send(
            new UpdateCommand({
              TableName: this.tableName,
              Key: { pk: householdKey(householdId) },
              UpdateExpression: 'REMOVE deleting',
              ConditionExpression: 'deleting = :token',
              ExpressionAttributeValues: { ':token': token },
            }),
          );
        } catch (error) {
          // Never reopen a newer concurrent deletion attempt's lock.
          if ((error as Error).name !== 'ConditionalCheckFailedException')
            throw error;
        }
        return { canDelete: false };
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return {
      canDelete: true,
      ...(parentLocked ? { token } : {}),
    };
  }

  async cancelHouseholdDeletion(
    householdId: string,
    ownerUserId: string,
    token: string,
  ): Promise<void> {
    for (let attempt = 1; attempt <= HOUSEHOLD_UNLOCK_MAX_ATTEMPTS; attempt++) {
      try {
        await this.dynamoDb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: { pk: accountDeletionJobKey(ownerUserId) },
                  ConditionExpression: 'attribute_not_exists(pk)',
                },
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: { pk: householdKey(householdId) },
                  UpdateExpression: 'REMOVE deleting',
                  ConditionExpression:
                    'ownerUserId = :owner AND deleting = :token',
                  ExpressionAttributeValues: {
                    ':owner': ownerUserId,
                    ':token': token,
                  },
                },
              },
            ],
          }),
        );
        return;
      } catch (error) {
        if ((error as Error).name !== 'TransactionCanceledException') {
          throw error;
        }
        const job = await this.dynamoDb.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: accountDeletionJobKey(ownerUserId) },
            ConsistentRead: true,
          }),
        );
        if (job.Item) return;
        const household = await this.dynamoDb.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: householdKey(householdId) },
            ConsistentRead: true,
          }),
        );
        if (
          household.Item?.ownerUserId !== ownerUserId ||
          household.Item?.deleting !== token
        ) {
          return;
        }
        if (attempt === HOUSEHOLD_UNLOCK_MAX_ATTEMPTS) throw error;
      }
    }
  }

  async deleteHouseholdCascade(householdId: string): Promise<void> {
    // Keep a closed tombstone until the strong sweep succeeds, so a retry can resume.
    try {
      await this.dynamoDb.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: householdKey(householdId) },
          UpdateExpression: 'SET deleting = if_not_exists(deleting, :token)',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':token': randomUUID() },
        }),
      );
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException')
        throw error;
    }
    let cursor: Record<string, unknown> | undefined;
    do {
      // Privacy cleanup needs a strong read; GSI propagation can miss recent writes.
      // ponytail: O(shared users table); move children to an owner partition/strong manifest before growth.
      const page = await this.dynamoDb.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression:
            'householdId = :household AND entityType IN (:householdEntity, :membership, :invite, :activity)',
          ExpressionAttributeValues: {
            ':household': householdId,
            ':householdEntity': 'HOUSEHOLD',
            ':membership': 'HOUSEHOLD_MEMBERSHIP',
            ':invite': 'HOUSEHOLD_INVITE',
            ':activity': 'HOUSEHOLD_ACTIVITY',
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        if (typeof item.pk !== 'string')
          throw new Error('Invalid household record key');
        try {
          await this.dynamoDb.send(
            new DeleteCommand({
              TableName: this.tableName,
              Key: { pk: item.pk },
              ConditionExpression:
                'householdId = :household AND entityType IN (:householdEntity, :membership, :invite, :activity)',
              ExpressionAttributeValues: {
                ':household': householdId,
                ':householdEntity': 'HOUSEHOLD',
                ':membership': 'HOUSEHOLD_MEMBERSHIP',
                ':invite': 'HOUSEHOLD_INVITE',
                ':activity': 'HOUSEHOLD_ACTIVITY',
              },
            }),
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== 'ConditionalCheckFailedException'
          )
            throw error;
          // The canonical user key may already belong to another household.
        }
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    await this.dynamoDb.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: householdKey(householdId) },
      }),
    );
  }

  private activeUserChecks(userIds: Array<string | undefined>): TransactItem[] {
    const now = new Date().toISOString();
    return [...new Set(userIds.filter((id): id is string => Boolean(id)))].map(
      (userId) => ({
        ConditionCheck: {
          TableName: this.tableName,
          Key: { pk: userKey(userId) },
          ConditionExpression:
            'attribute_exists(pk) AND #status = :active AND (attribute_not_exists(deletionFenceExpiresAt) OR deletionFenceExpiresAt <= :now)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':active': 'active', ':now': now },
        },
      }),
    );
  }

  private async findUserLookup(
    email: string,
  ): Promise<{ userId: string } | undefined> {
    const result = await this.dynamoDb.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: emailKey(email) },
        ConsistentRead: true,
      }),
    );
    return typeof result.Item?.userId === 'string'
      ? { userId: result.Item.userId }
      : undefined;
  }

  private accountDeletionChange(
    item: Record<string, unknown>,
    userId: string,
    email: string,
  ): TransactItem {
    if (typeof item.pk !== 'string')
      throw new Error('Invalid household record key');
    if (item.entityType === 'HOUSEHOLD_MEMBERSHIP') {
      return {
        Delete: {
          TableName: this.tableName,
          Key: { pk: item.pk },
          ConditionExpression: 'userId = :user',
          ExpressionAttributeValues: { ':user': userId },
        },
      };
    }
    if (item.entityType === 'HOUSEHOLD_ACTIVITY') {
      const actorMatches = item.actorUserId === userId;
      const targetMatches = item.targetUserId === userId;
      const updates = [
        ...(actorMatches ? ['actorUserId = :anonymousUser'] : []),
        ...(targetMatches
          ? ['targetUserId = :anonymousUser', 'targetLabel = :anonymousLabel']
          : []),
      ];
      return {
        Update: {
          TableName: this.tableName,
          Key: { pk: item.pk },
          UpdateExpression: `SET ${updates.join(', ')}`,
          ConditionExpression: 'actorUserId = :user OR targetUserId = :user',
          ExpressionAttributeValues: {
            ':user': userId,
            ':anonymousUser': ANONYMIZED_USER_ID,
            ...(targetMatches ? { ':anonymousLabel': ANONYMIZED_LABEL } : {}),
          },
        },
      };
    }
    if (item.entityType === 'HOUSEHOLD_INVITE') {
      const inviterMatches = item.invitedByUserId === userId;
      const now = new Date().toISOString();
      return {
        Update: {
          TableName: this.tableName,
          Key: { pk: item.pk },
          UpdateExpression: `SET invitedEmail = :anonymousEmail, revokedAt = :now, updatedAt = :now, privacyRedacted = :redacted${inviterMatches ? ', invitedByUserId = :anonymousUser' : ''}`,
          ConditionExpression:
            'invitedByUserId = :user OR invitedEmail = :email',
          ExpressionAttributeValues: {
            ':user': userId,
            ':email': email,
            ':anonymousEmail': ANONYMIZED_EMAIL,
            ':now': now,
            ':redacted': true,
            ...(inviterMatches ? { ':anonymousUser': ANONYMIZED_USER_ID } : {}),
          },
        },
      };
    }
    throw new Error('Unsupported household privacy record');
  }

  private async query<T>(
    input: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName'>,
  ): Promise<T[]> {
    const items: T[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.dynamoDb.send(
        new QueryCommand({
          TableName: this.tableName,
          ...input,
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      );

      items.push(...((result.Items ?? []) as T[]));
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
    } while (exclusiveStartKey && !input.Limit);

    return items;
  }

  private toHouseholdItem(household: Household): HouseholdItem {
    const primitives = household.toPrimitives();

    return {
      pk: householdKey(primitives.id),
      entityType: 'HOUSEHOLD',
      gsi2pk: householdRecordsKey(primitives.id),
      gsi2sk: 'HOUSEHOLD',
      id: primitives.id,
      name: primitives.name,
      ownerUserId: primitives.ownerUserId,
      createdAt: primitives.createdAt.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
    };
  }

  private toMembershipItem(membership: HouseholdMembership): MembershipItem {
    const primitives = membership.toPrimitives();

    return {
      pk: membershipByUserKey(primitives.userId),
      entityType: 'HOUSEHOLD_MEMBERSHIP',
      gsi1pk: membershipByUserKey(primitives.userId),
      gsi1sk: primitives.householdId,
      gsi2pk: householdRecordsKey(primitives.householdId),
      gsi2sk: `MEMBER#${primitives.joinedAt.toISOString()}#USER#${primitives.userId}`,
      householdId: primitives.householdId,
      userId: primitives.userId,
      email: primitives.email,
      username: primitives.username,
      role: primitives.role,
      joinedAt: primitives.joinedAt.toISOString(),
      createdAt: primitives.joinedAt.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
    };
  }

  private toInviteItem(invite: HouseholdInvite): InviteItem {
    const primitives = invite.toPrimitives();

    return {
      pk: inviteKey(primitives.id),
      entityType: 'HOUSEHOLD_INVITE',
      gsi1pk: inviteByTokenKey(primitives.tokenHash),
      gsi1sk: primitives.id,
      gsi2pk: householdRecordsKey(primitives.householdId),
      gsi2sk: `INVITE#${primitives.createdAt.toISOString()}#${primitives.id}`,
      id: primitives.id,
      householdId: primitives.householdId,
      invitedEmail: primitives.invitedEmail,
      invitedByUserId: primitives.invitedByUserId,
      role: primitives.role,
      tokenHash: primitives.tokenHash,
      createdAt: primitives.createdAt.toISOString(),
      expiresAt: primitives.expiresAt.toISOString(),
      acceptedAt: primitives.acceptedAt?.toISOString(),
      revokedAt: primitives.revokedAt?.toISOString(),
      updatedAt: primitives.updatedAt.toISOString(),
      expiresAtEpochSeconds: Math.floor(primitives.expiresAt.getTime() / 1000),
    };
  }

  private toActivityItem(activity: HouseholdActivity): ActivityItem {
    const primitives = activity.toPrimitives();

    return {
      pk: activityKey(primitives.id),
      entityType: 'HOUSEHOLD_ACTIVITY',
      gsi2pk: householdRecordsKey(primitives.householdId),
      gsi2sk: `ACTIVITY#${primitives.createdAt.toISOString()}#${primitives.id}`,
      id: primitives.id,
      householdId: primitives.householdId,
      type: primitives.type,
      actorUserId: primitives.actorUserId,
      targetUserId: primitives.targetUserId,
      targetLabel: primitives.targetLabel,
      role: primitives.role,
      createdAt: primitives.createdAt.toISOString(),
    };
  }

  private toHousehold(item: HouseholdItem): Household {
    return Household.fromPrimitives({
      id: item.id,
      name: item.name,
      ownerUserId: item.ownerUserId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    });
  }

  private toMembership(item: MembershipItem): HouseholdMembership {
    return HouseholdMembership.fromPrimitives({
      householdId: item.householdId,
      userId: item.userId,
      email: item.email,
      username: item.username,
      role: item.role,
      joinedAt: new Date(item.joinedAt),
      updatedAt: new Date(item.updatedAt),
    });
  }

  private toInvite(item: InviteItem): HouseholdInvite {
    return HouseholdInvite.fromPrimitives({
      id: item.id,
      householdId: item.householdId,
      invitedEmail: item.invitedEmail,
      invitedByUserId: item.invitedByUserId,
      role: item.role,
      tokenHash: item.tokenHash,
      createdAt: new Date(item.createdAt),
      expiresAt: new Date(item.expiresAt),
      acceptedAt: item.acceptedAt ? new Date(item.acceptedAt) : undefined,
      revokedAt: item.revokedAt ? new Date(item.revokedAt) : undefined,
      updatedAt: new Date(item.updatedAt),
    });
  }

  private toActivity(item: ActivityItem): HouseholdActivity {
    return HouseholdActivity.fromPrimitives({
      id: item.id,
      householdId: item.householdId,
      type: item.type,
      actorUserId: item.actorUserId,
      targetUserId: item.targetUserId,
      targetLabel: item.targetLabel,
      role: item.role,
      createdAt: new Date(item.createdAt),
    });
  }
}

function householdKey(id: string): string {
  return `HOUSEHOLD#${id}`;
}

function accountDeletionJobKey(userId: string): string {
  return `ACCOUNT_DELETION_JOB#${userId}`;
}

function userKey(id: string): string {
  return `USER#${id}`;
}

function emailKey(email: string): string {
  return `EMAIL#${email.trim().toLocaleLowerCase('en-US')}`;
}

function inviteKey(id: string): string {
  return `HOUSEHOLD_INVITE#${id}`;
}

function activityKey(id: string): string {
  return `HOUSEHOLD_ACTIVITY#${id}`;
}

function householdRecordsKey(householdId: string): string {
  return `HOUSEHOLD#${householdId}`;
}

function membershipByUserKey(userId: string): string {
  return `HOUSEHOLD_MEMBER_BY_USER#${userId}`;
}

function inviteByTokenKey(tokenHash: string): string {
  return `HOUSEHOLD_INVITE_BY_TOKEN#${tokenHash}`;
}
