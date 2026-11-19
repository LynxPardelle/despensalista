import { ConfigService } from '@nestjs/config';
import { createConnection, Connection } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { AccessCodeStore } from './access-code.store';
import type {
  AccessCodeRecord,
  AccessCodeRedemption,
} from './access-code.types';

describe('AccessCodeStore Mongo transaction', () => {
  let server: MongoMemoryReplSet;
  let connection: Connection;
  let store: AccessCodeStore;
  const code: AccessCodeRecord = {
    id: 'code-1',
    plan: 'plus',
    mode: 'plan',
    lifetime: false,
    months: 1,
    redeemUntil: '2099-01-01T00:00:00.000Z',
    createdAt: '2026-11-18T00:00:00.000Z',
    reason: 'beta-test',
    state: 'issued',
    secretHash: 'a'.repeat(64),
    recipientEmail: 'owner@example.test',
  };
  const redemption: AccessCodeRedemption = {
    code,
    userId: 'owner',
    householdId: 'home-1',
    joinedAt: '2026-11-18T00:00:00.000Z',
    contextVersion: 'context-1',
    expectedRevision: 0,
    redeemedByHash: 'b'.repeat(64),
    grant: {
      id: code.id,
      plan: 'plus',
      mode: 'plan',
      lifetime: false,
      startsAt: '2026-11-18T00:00:00.000Z',
      expiresAt: '2027-01-18T00:00:00.000Z',
    },
  };

  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    connection = await createConnection(server.getUri(), {
      dbName: 'access-code-transactions',
    }).asPromise();
    store = new AccessCodeStore(
      new ConfigService({ PERSISTENCE_PROVIDER: 'mongodb' }),
      undefined,
      connection,
    );
    await store.onModuleInit();
  }, 60_000);
  afterAll(async () => {
    await connection?.close();
    await server?.stop();
  });
  beforeEach(async () => {
    await connection.collection('access_codes').deleteMany({});
    await connection.collection('users').deleteMany({});
    await connection.collection('households').deleteMany({});
    await connection
      .collection('users')
      .insertOne({ id: 'owner', status: 'active' });
    await connection.collection('households').insertMany([
      { pk: 'HOUSEHOLD#home-1', entityType: 'HOUSEHOLD', ownerUserId: 'owner' },
      {
        pk: 'member-key',
        entityType: 'HOUSEHOLD_MEMBERSHIP',
        userId: 'owner',
        householdId: 'home-1',
        role: 'owner',
        contextVersion: 'context-1',
        joinedAt: new Date(redemption.joinedAt),
      },
    ]);
    expect(await store.issue(code)).toBe(true);
  });

  it('allows only one commit when the same code is redeemed concurrently', async () => {
    const results = await Promise.all([
      store.commitRedemption(redemption),
      store.commitRedemption(redemption),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.readCode(code.id))?.state).toBe('redeemed');
    expect((await store.readGrants('home-1')).grants).toEqual([
      redemption.grant,
    ]);
  });

  it('rolls back the code when the owner membership is stale', async () => {
    await connection
      .collection('households')
      .updateOne({ pk: 'member-key' }, { $set: { contextVersion: 'changed' } });
    expect(await store.commitRedemption(redemption)).toBe(false);
    expect((await store.readCode(code.id))?.state).toBe('issued');
    expect((await store.readGrants('home-1')).grants).toHaveLength(0);
  });

  it('revokes a consumed grant, then scrubs its receipt during deletion', async () => {
    expect(await store.commitRedemption(redemption)).toBe(true);
    expect(await store.revoke(code.id, 'test-complete')).toBe(true);
    expect((await store.readGrants('home-1')).grants).toHaveLength(0);
    await store.deleteHousehold('home-1');
    const receipt = await store.readCode(code.id);
    expect(receipt?.state).toBe('revoked');
    expect(receipt).not.toHaveProperty('recipientEmail');
    expect(receipt).not.toHaveProperty('redeemedHouseholdId');
    expect(receipt).not.toHaveProperty('redeemedByHash');
  });

  it('limits persistent attempts and has a TTL index', async () => {
    for (let index = 0; index < 10; index++)
      expect(await store.reserveAttempt('owner', new Date())).toBe(true);
    expect(await store.reserveAttempt('owner', new Date())).toBe(false);
    const indexes = await connection.collection('access_codes').indexes();
    expect(indexes.some((index) => index.expireAfterSeconds === 0)).toBe(true);
  });
});
