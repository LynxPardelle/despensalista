import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { AccessCodeStore } from './access-code.store';
import { DynamoDbDocumentClientService } from '../database/dynamodb/dynamodb-document-client.service';
import {
  activeAccessGrants,
  publicAccessCodeMetadata,
  type AccessCodeRecord,
  type AccessCodeRedemption,
} from './access-code.types';

const code: AccessCodeRecord = {
  id: 'code-1',
  plan: 'plus',
  mode: 'plan',
  lifetime: false,
  months: 2,
  redeemUntil: '2099-01-01T00:00:00.000Z',
  createdAt: '2026-11-18T00:00:00.000Z',
  reason: 'beta-test',
  state: 'issued',
  secretHash: 'a'.repeat(64),
};
const redemption: AccessCodeRedemption = {
  code,
  userId: 'owner',
  householdId: 'home-1',
  joinedAt: '2026-11-18T00:00:00.000Z',
  contextVersion: 'context-1',
  expectedRevision: 0,
  redeemedByHash: 'b'.repeat(64),
  billingTable: 'billing',
  billingRevision: 4,
  grant: {
    id: code.id,
    plan: 'plus',
    mode: 'plan',
    lifetime: false,
    startsAt: '2026-11-18T00:00:00.000Z',
    expiresAt: '2027-01-18T00:00:00.000Z',
  },
};

describe('AccessCodeStore', () => {
  let send: jest.Mock;
  let store: AccessCodeStore;
  beforeEach(() => {
    send = jest.fn().mockResolvedValue({});
    store = new AccessCodeStore(
      new ConfigService({
        PERSISTENCE_PROVIDER: 'dynamodb',
        DYNAMODB_USERS_TABLE: 'users',
      }),
      { send } as unknown as DynamoDbDocumentClientService,
    );
  });

  it('reads grant history strongly and uses a revision fence for first creation', async () => {
    expect(await store.commitRedemption(redemption)).toBe(true);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input.ConsistentRead).toBe(true);
    const transaction = send.mock.calls[1][0] as TransactWriteCommand;
    expect(transaction.input.TransactItems).toHaveLength(7);
    expect(transaction.input.TransactItems?.[0]?.Update).toMatchObject({
      Key: { pk: 'ACCESS_CODE#code-1' },
      ConditionExpression:
        '#state = :issued AND secretHash = :hash AND redeemUntil > :now',
    });
    expect(transaction.input.TransactItems?.[1]?.Put).toMatchObject({
      ConditionExpression: 'attribute_not_exists(pk)',
      Item: { householdId: 'home-1', revision: 1, grants: [redemption.grant] },
    });
    expect(transaction.input.TransactItems?.[4]?.ConditionCheck).toMatchObject({
      Key: { pk: 'HOUSEHOLD_MEMBER_BY_USER#owner' },
      ExpressionAttributeValues: { ':context': 'context-1', ':owner': 'owner' },
    });
    expect(
      transaction.input.TransactItems?.[5]?.ConditionCheck?.ConditionExpression,
    ).toContain('cancelAtPeriodEnd = :yes');
    expect(
      transaction.input.TransactItems?.[5]?.ConditionCheck?.ConditionExpression,
    ).toContain('revision = :revision');
    expect(transaction.input.TransactItems?.[6]?.ConditionCheck).toMatchObject({
      Key: { pk: 'checkout-lock:home-1' },
      ConditionExpression:
        'attribute_not_exists(closing) AND (attribute_not_exists(lease) OR leaseUntil <= :now)',
    });
  });

  it('rejects an outdated aggregate before trying to consume another code', async () => {
    send.mockResolvedValue({
      Item: {
        entityType: 'ACCESS_GRANTS',
        householdId: 'home-1',
        revision: 1,
        grants: [],
      },
    });
    expect(await store.commitRedemption(redemption)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps a transaction conflict to a retry and preserves operational errors', async () => {
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error(), { name: 'TransactionCanceledException' }),
      );
    expect(await store.commitRedemption(redemption)).toBe(false);
    send
      .mockReset()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
      );
    await expect(store.commitRedemption(redemption)).rejects.toThrow('denied');
    const validation = Object.assign(new Error('invalid transaction'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ValidationError' }],
    });
    send
      .mockReset()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(validation);
    await expect(store.commitRedemption(redemption)).rejects.toBe(validation);
  });

  it('revokes the redeemed code and removes only its grant in one CAS transaction', async () => {
    const other = { ...redemption.grant, id: 'other-code' };
    send
      .mockResolvedValueOnce({
        Item: {
          ...code,
          state: 'redeemed',
          redeemedHouseholdId: 'home-1',
          entityType: 'ACCESS_CODE',
        },
      })
      .mockResolvedValueOnce({
        Item: {
          entityType: 'ACCESS_GRANTS',
          householdId: 'home-1',
          revision: 2,
          grants: [redemption.grant, other],
        },
      });
    expect(await store.revoke(code.id, 'wrong-delivery')).toBe(true);
    const transaction = send.mock.calls[2][0] as TransactWriteCommand;
    expect(transaction.input.TransactItems?.[1]?.Put).toMatchObject({
      Item: { grants: [other], revision: 3 },
      ConditionExpression: 'revision = :revision',
      ExpressionAttributeValues: { ':revision': 2 },
    });
  });

  it('uses a bounded hashed hourly attempt bucket and returns false at its limit', async () => {
    const instant = new Date('2026-11-18T01:05:00.000Z');
    expect(await store.reserveAttempt('owner', instant)).toBe(true);
    const command = send.mock.calls[0][0] as UpdateCommand;
    expect(command.input.Key?.pk).toContain(
      createHash('sha256').update('owner').digest('hex'),
    );
    expect(command.input.ExpressionAttributeValues?.[':maximum']).toBe(10);
    expect(command.input.ExpressionAttributeValues?.[':expires']).toBe(
      Math.floor(instant.getTime() / 3_600_000 + 2) * 3600,
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }),
    );
    expect(await store.reserveAttempt('owner', instant)).toBe(false);
  });

  it('paginates indexed metadata and omits internal fields and digests', async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          ...code,
          entityType: 'ACCESS_CODE',
          pk: 'hidden',
          redeemedByHash: 'hidden',
        },
      ],
      LastEvaluatedKey: { pk: 'cursor' },
    });
    const page = await store.list(undefined, 2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(page.items[0]).toMatchObject({ id: code.id, state: 'issued' });
    expect(page.items[0]).not.toHaveProperty('pk');
    expect(page.items[0]).not.toHaveProperty('secretHash');
    expect(page.items[0]).not.toHaveProperty('redeemedByHash');
    expect(page.cursor).toBeDefined();
  });

  it('expires access at the exact boundary and preserves scheduled and lifetime semantics', () => {
    const grants = {
      householdId: 'home-1',
      revision: 1,
      grants: [redemption.grant],
    };
    expect(
      activeAccessGrants(grants, new Date(redemption.grant.expiresAt!)),
    ).toHaveLength(0);
    expect(
      activeAccessGrants(grants, new Date('2026-11-17T00:00:00.000Z')),
    ).toHaveLength(0);
    expect(
      activeAccessGrants(grants, new Date('2026-12-17T00:00:00.000Z')),
    ).toHaveLength(1);
    expect(publicAccessCodeMetadata(code)).not.toHaveProperty('secretHash');
  });
});
