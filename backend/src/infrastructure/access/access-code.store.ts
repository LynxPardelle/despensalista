import {
  Injectable,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import {
  GetCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { Connection } from 'mongoose';
import { DynamoDbDocumentClientService } from '../database/dynamodb/dynamodb-document-client.service';
import {
  publicAccessCodeMetadata,
  type AccessCodePage,
  type AccessCodeRecord,
  type AccessCodeRedemption,
  type AccessGrantsSnapshot,
  type AccessGrant,
} from './access-code.types';

type TransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number];
type StoredDocument = Partial<AccessCodeRecord> & {
  _id: string;
  entityType?: string;
  householdId?: string;
  grants?: AccessGrant[];
  attempts?: number;
  revision?: number;
  expiresAt?: Date;
};
const MAX_ATTEMPTS = 10;
const HOUR_MS = 60 * 60 * 1000;
export { activeAccessGrants } from './access-code.types';

@Injectable()
export class AccessCodeStore implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly dynamodb?: DynamoDbDocumentClientService,
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.isDynamo) return;
    await this.documents.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, sparse: true },
    );
    await this.documents.createIndex({ entityType: 1, _id: -1 });
  }

  async readCode(id: string): Promise<AccessCodeRecord | undefined> {
    const item = await this.read(codeKey(id));
    return item?.entityType === 'ACCESS_CODE'
      ? (item as unknown as AccessCodeRecord)
      : undefined;
  }

  async readGrants(householdId: string): Promise<AccessGrantsSnapshot> {
    const item = await this.read(grantsKey(householdId));
    return item?.entityType === 'ACCESS_GRANTS'
      ? (item as unknown as AccessGrantsSnapshot)
      : { householdId, revision: 0, grants: [] };
  }

  async reserveAttempt(userId: string, now: Date): Promise<boolean> {
    const hour = Math.floor(now.getTime() / HOUR_MS);
    const identity = createHash('sha256').update(userId).digest('hex');
    const pk = `ACCESS_CODE_ATTEMPTS#${identity}#${hour}`;
    const expiresAtEpochSeconds = (hour + 2) * 3600;
    if (this.isDynamo) {
      try {
        await this.db.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk },
            UpdateExpression:
              'SET entityType = :entity, expiresAtEpochSeconds = :expires ADD attempts :one',
            ConditionExpression:
              'attribute_not_exists(attempts) OR attempts < :maximum',
            ExpressionAttributeValues: {
              ':entity': 'ACCESS_CODE_ATTEMPTS',
              ':expires': expiresAtEpochSeconds,
              ':one': 1,
              ':maximum': MAX_ATTEMPTS,
            },
          }),
        );
        return true;
      } catch (error) {
        if (writeConflict(error)) return false;
        throw error;
      }
    }
    try {
      const result = await this.documents.findOneAndUpdate(
        {
          _id: pk,
          $or: [
            { attempts: { $exists: false } },
            { attempts: { $lt: MAX_ATTEMPTS } },
          ],
        },
        {
          $setOnInsert: {
            entityType: 'ACCESS_CODE_ATTEMPTS',
            expiresAt: new Date(expiresAtEpochSeconds * 1000),
          },
          $inc: { attempts: 1 },
        },
        { upsert: true, returnDocument: 'after' },
      );
      return result !== null;
    } catch (error) {
      if (writeConflict(error)) return false;
      throw error;
    }
  }

  async issue(code: AccessCodeRecord): Promise<boolean> {
    if (code.state !== 'issued')
      throw new Error('Only new codes can be issued');
    const item = {
      ...code,
      pk: codeKey(code.id),
      entityType: 'ACCESS_CODE',
      gsi2pk: 'ACCESS_CODES',
      gsi2sk: `${code.createdAt}#${code.id}`,
    };
    try {
      if (this.isDynamo) {
        await this.db.send(
          new PutCommand({
            TableName: this.table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
      } else {
        await this.documents.insertOne({ ...item, _id: item.pk });
      }
      return true;
    } catch (error) {
      if (writeConflict(error)) return false;
      throw error;
    }
  }

  async list(cursor?: string, limit = 25): Promise<AccessCodePage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid page size');
    const offset = cursor ? decodeCursor(cursor) : undefined;
    if (this.isDynamo) {
      const result = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'gsi2',
          KeyConditionExpression: 'gsi2pk = :entity',
          ExpressionAttributeValues: { ':entity': 'ACCESS_CODES' },
          ScanIndexForward: false,
          Limit: limit,
          ...(offset ? { ExclusiveStartKey: offset } : {}),
        }),
      );
      return {
        items: (result.Items ?? []).map((item) =>
          publicAccessCodeMetadata(item as unknown as AccessCodeRecord),
        ),
        ...(result.LastEvaluatedKey
          ? { cursor: encodeCursor(result.LastEvaluatedKey) }
          : {}),
      };
    }
    const lastId = offset?._id;
    if (lastId !== undefined && typeof lastId !== 'string')
      throw new Error('Invalid cursor');
    const rows = await this.documents
      .find({
        entityType: 'ACCESS_CODE',
        ...(lastId ? { _id: { $lt: lastId } } : {}),
      })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .toArray();
    const items = rows.slice(0, limit);
    return {
      items: items.map((item) =>
        publicAccessCodeMetadata(item as unknown as AccessCodeRecord),
      ),
      ...(rows.length > limit
        ? { cursor: encodeCursor({ _id: items.at(-1)!._id }) }
        : {}),
    };
  }

  async commitRedemption(input: AccessCodeRedemption): Promise<boolean> {
    const snapshot = await this.readGrants(input.householdId);
    if (snapshot.revision !== input.expectedRevision) return false;
    const next = {
      ...snapshot,
      revision: snapshot.revision + 1,
      grants: [...snapshot.grants, input.grant],
    };
    if (Buffer.byteLength(JSON.stringify(next)) > 350_000)
      throw new ServiceUnavailableException('Access history is full');
    return this.isDynamo
      ? this.commitDynamo(input, next)
      : this.commitMongo(input, next);
  }

  private async commitDynamo(
    input: AccessCodeRedemption,
    next: AccessGrantsSnapshot,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const membershipCondition = input.contextVersion
      ? 'contextVersion = :context'
      : 'attribute_not_exists(contextVersion) AND joinedAt = :joinedAt';
    const items: TransactionItem[] = [
      {
        Update: {
          TableName: this.table,
          Key: { pk: codeKey(input.code.id) },
          UpdateExpression:
            'SET #state = :redeemed, redeemedAt = :now, redeemedByHash = :actor, redeemedHouseholdId = :household',
          ConditionExpression:
            '#state = :issued AND secretHash = :hash AND redeemUntil > :now',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: {
            ':redeemed': 'redeemed',
            ':now': now,
            ':actor': input.redeemedByHash,
            ':household': input.householdId,
            ':issued': 'issued',
            ':hash': input.code.secretHash,
          },
        },
      },
      {
        Put: {
          TableName: this.table,
          Item: {
            ...next,
            pk: grantsKey(input.householdId),
            entityType: 'ACCESS_GRANTS',
          },
          ConditionExpression: snapshotCondition(input.expectedRevision),
          ...(input.expectedRevision
            ? {
                ExpressionAttributeValues: {
                  ':revision': input.expectedRevision,
                },
              }
            : {}),
        },
      },
      {
        ConditionCheck: {
          TableName: this.table,
          Key: { pk: `USER#${input.userId}` },
          ConditionExpression:
            '#status = :active AND (attribute_not_exists(deletionFenceExpiresAt) OR deletionFenceExpiresAt <= :now)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':active': 'active', ':now': now },
        },
      },
      {
        ConditionCheck: {
          TableName: this.table,
          Key: { pk: `HOUSEHOLD#${input.householdId}` },
          ConditionExpression:
            'ownerUserId = :owner AND attribute_not_exists(deleting)',
          ExpressionAttributeValues: { ':owner': input.userId },
        },
      },
      {
        ConditionCheck: {
          TableName: this.table,
          Key: { pk: `HOUSEHOLD_MEMBER_BY_USER#${input.userId}` },
          ConditionExpression: `householdId = :household AND #role = :owner AND ${membershipCondition}`,
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: {
            ':household': input.householdId,
            ':owner': 'owner',
            ...(input.contextVersion
              ? { ':context': input.contextVersion }
              : { ':joinedAt': input.joinedAt }),
          },
        },
      },
      ...billingConditions(input, now),
    ];
    return this.transact(items);
  }

  private async commitMongo(
    input: AccessCodeRedemption,
    next: AccessGrantsSnapshot,
  ): Promise<boolean> {
    const session = await this.mongo.startSession();
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const user = await this.mongo.collection('users').updateOne(
          {
            id: input.userId,
            status: 'active',
            $or: [
              { deletionFenceExpiresAt: { $exists: false } },
              { deletionFenceExpiresAt: { $lte: now } },
            ],
          },
          { $inc: { householdMutationVersion: 1 } },
          { session },
        );
        const parent = await this.mongo.collection('households').updateOne(
          {
            pk: `HOUSEHOLD#${input.householdId}`,
            ownerUserId: input.userId,
            deleting: { $exists: false },
          },
          { $inc: { mutationVersion: 1 } },
          { session },
        );
        const membership = await this.mongo.collection('households').updateOne(
          {
            entityType: 'HOUSEHOLD_MEMBERSHIP',
            userId: input.userId,
            householdId: input.householdId,
            role: 'owner',
            ...(input.contextVersion
              ? { contextVersion: input.contextVersion }
              : {
                  contextVersion: { $exists: false },
                  joinedAt: new Date(input.joinedAt),
                }),
          },
          { $inc: { accessMutationVersion: 1 } },
          { session },
        );
        if (
          user.matchedCount !== 1 ||
          parent.matchedCount !== 1 ||
          membership.matchedCount !== 1
        )
          throw new AccessWriteConflict();
        const code = await this.documents.updateOne(
          {
            _id: codeKey(input.code.id),
            state: 'issued',
            secretHash: input.code.secretHash,
            redeemUntil: { $gt: now.toISOString() },
          },
          {
            $set: {
              state: 'redeemed',
              redeemedAt: now.toISOString(),
              redeemedByHash: input.redeemedByHash,
              redeemedHouseholdId: input.householdId,
            },
          },
          { session },
        );
        if (code.matchedCount !== 1) throw new AccessWriteConflict();
        const result = await this.documents.replaceOne(
          {
            _id: grantsKey(input.householdId),
            ...(input.expectedRevision
              ? { revision: input.expectedRevision }
              : { revision: { $exists: false } }),
          },
          {
            ...next,
            entityType: 'ACCESS_GRANTS',
          },
          { session, upsert: input.expectedRevision === 0 },
        );
        if (result.matchedCount + result.upsertedCount !== 1)
          throw new AccessWriteConflict();
      });
      return true;
    } catch (error) {
      if (writeConflict(error)) return false;
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async revoke(id: string, reason: string): Promise<boolean> {
    const code = await this.readCode(id);
    if (!code) return false;
    if (code.state === 'revoked') return true;
    const householdId = code.redeemedHouseholdId;
    const snapshot = householdId
      ? await this.readGrants(householdId)
      : undefined;
    const revokedAt = new Date().toISOString();
    if (this.isDynamo) {
      return this.transact([
        {
          Update: {
            TableName: this.table,
            Key: { pk: codeKey(id) },
            UpdateExpression:
              'SET #state = :revoked, revokedAt = :now, revokedReason = :reason',
            ConditionExpression: '#state = :previous',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':revoked': 'revoked',
              ':now': revokedAt,
              ':reason': reason,
              ':previous': code.state,
            },
          },
        },
        ...(snapshot && snapshot.revision > 0
          ? [
              {
                Put: {
                  TableName: this.table,
                  Item: {
                    ...snapshot,
                    pk: grantsKey(householdId!),
                    entityType: 'ACCESS_GRANTS',
                    revision: snapshot.revision + 1,
                    grants: snapshot.grants.filter((grant) => grant.id !== id),
                  },
                  ConditionExpression: 'revision = :revision',
                  ExpressionAttributeValues: { ':revision': snapshot.revision },
                },
              },
            ]
          : []),
      ]);
    }
    const session = await this.mongo.startSession();
    try {
      await session.withTransaction(async () => {
        const update = await this.documents.updateOne(
          { _id: codeKey(id), state: code.state },
          { $set: { state: 'revoked', revokedAt, revokedReason: reason } },
          { session },
        );
        if (update.matchedCount !== 1) throw new AccessWriteConflict();
        if (snapshot && snapshot.revision > 0) {
          const grants = await this.documents.updateOne(
            { _id: grantsKey(householdId!), revision: snapshot.revision },
            {
              $set: {
                grants: snapshot.grants.filter((grant) => grant.id !== id),
              },
              $inc: { revision: 1 },
            },
            { session },
          );
          if (grants.matchedCount !== 1) throw new AccessWriteConflict();
        }
      });
      return true;
    } catch (error) {
      if (writeConflict(error)) return false;
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async deleteHousehold(householdId: string): Promise<void> {
    if ((await this.readGrants(householdId)).revision === 0) return;
    if (!this.isDynamo) {
      const session = await this.mongo.startSession();
      try {
        await session.withTransaction(async () => {
          await this.documents.deleteOne(
            { _id: grantsKey(householdId) },
            { session },
          );
          await this.documents.updateMany(
            { entityType: 'ACCESS_CODE', redeemedHouseholdId: householdId },
            {
              $set: { state: 'revoked', revokedReason: 'household-deleted' },
              $unset: {
                recipientEmail: '',
                redeemedHouseholdId: '',
                redeemedByHash: '',
              },
            },
            { session },
          );
        });
      } finally {
        await session.endSession();
      }
      return;
    }
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.db.send(
        new ScanCommand({
          TableName: this.table,
          ConsistentRead: true,
          FilterExpression:
            'entityType = :entity AND redeemedHouseholdId = :household',
          ExpressionAttributeValues: {
            ':entity': 'ACCESS_CODE',
            ':household': householdId,
          },
          ProjectionExpression: 'pk',
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const row of page.Items ?? []) {
        if (typeof row.pk !== 'string')
          throw new Error('Invalid access-code storage key');
        await this.db.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { pk: row.pk },
            UpdateExpression:
              'SET #state = :revoked, revokedReason = :reason REMOVE recipientEmail, redeemedHouseholdId, redeemedByHash',
            ConditionExpression: 'redeemedHouseholdId = :household',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':revoked': 'revoked',
              ':reason': 'household-deleted',
              ':household': householdId,
            },
          }),
        );
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    await this.db.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { pk: grantsKey(householdId) },
      }),
    );
  }

  private async read(pk: string): Promise<Record<string, unknown> | undefined> {
    if (this.isDynamo) {
      const result = await this.db.send(
        new GetCommand({
          TableName: this.table,
          Key: { pk },
          ConsistentRead: true,
        }),
      );
      return result.Item;
    }
    return (await this.documents.findOne({ _id: pk })) ?? undefined;
  }

  private async transact(items: TransactionItem[]): Promise<boolean> {
    try {
      await this.db.send(new TransactWriteCommand({ TransactItems: items }));
      return true;
    } catch (error) {
      if (writeConflict(error)) return false;
      throw error;
    }
  }

  private get isDynamo(): boolean {
    return this.config.get('PERSISTENCE_PROVIDER') === 'dynamodb';
  }
  private get table(): string {
    return this.config.getOrThrow<string>('DYNAMODB_USERS_TABLE');
  }
  private get db(): DynamoDbDocumentClientService {
    if (!this.dynamodb)
      throw new ServiceUnavailableException('Access codes are unavailable');
    return this.dynamodb;
  }
  private get mongo(): Connection {
    if (!this.connection)
      throw new ServiceUnavailableException('Access codes are unavailable');
    return this.connection;
  }
  private get documents() {
    return this.mongo.collection<StoredDocument>('access_codes');
  }
}

class AccessWriteConflict extends Error {}
function codeKey(id: string): string {
  return `ACCESS_CODE#${id}`;
}
function grantsKey(householdId: string): string {
  return `ACCESS_GRANTS#${householdId}`;
}
function snapshotCondition(revision: number): string {
  return revision ? 'revision = :revision' : 'attribute_not_exists(pk)';
}
function writeConflict(error: unknown): boolean {
  const value = error as {
    name?: string;
    code?: number;
    CancellationReasons?: Array<{ Code?: string }>;
  };
  if (value.name === 'TransactionCanceledException') {
    return !value.CancellationReasons?.some(
      (reason) =>
        reason.Code &&
        !['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(
          reason.Code,
        ),
    );
  }
  return (
    error instanceof AccessWriteConflict ||
    value.code === 11000 ||
    [
      'ConditionalCheckFailedException',
      'TransactionConflictException',
    ].includes(value.name ?? '')
  );
}
function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeCursor(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(
    Buffer.from(value, 'base64url').toString('utf8'),
  );
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new Error('Invalid cursor');
  return decoded as Record<string, unknown>;
}
function billingConditions(
  input: AccessCodeRedemption,
  now: string,
): TransactionItem[] {
  if (!input.billingTable) return [];
  return [
    {
      ConditionCheck: {
        TableName: input.billingTable,
        Key: { pk: `household:${input.householdId}` },
        ConditionExpression:
          '(attribute_not_exists(#status) OR #status IN (:canceled, :expired) OR (#status = :active AND cancelAtPeriodEnd = :yes)) AND (attribute_not_exists(checkout) OR checkout.expiresAt <= :seconds) AND (attribute_not_exists(closed) OR closed = :no)' +
          (input.billingRevision === undefined
            ? ''
            : input.billingRevision === 0
              ? ' AND attribute_not_exists(revision)'
              : ' AND revision = :revision'),
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':seconds': Math.floor(Date.parse(now) / 1000),
          ':canceled': 'canceled',
          ':expired': 'incomplete_expired',
          ':active': 'active',
          ':yes': true,
          ':no': false,
          ...(input.billingRevision
            ? { ':revision': input.billingRevision }
            : {}),
        },
      },
    },
    {
      ConditionCheck: {
        TableName: input.billingTable,
        Key: { pk: `checkout-lock:${input.householdId}` },
        ConditionExpression:
          'attribute_not_exists(closing) AND (attribute_not_exists(lease) OR leaseUntil <= :now)',
        ExpressionAttributeValues: { ':now': Date.parse(now) },
      },
    },
  ];
}
