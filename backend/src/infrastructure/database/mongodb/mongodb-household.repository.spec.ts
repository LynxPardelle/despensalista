import { ConflictException } from '@nestjs/common';
import { Connection, createConnection, Model } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  Household,
  HouseholdActivity,
  HouseholdInvite,
  HouseholdMembership,
} from '../../../domain/entities/household.entity';
import { User } from '../../../domain/entities/user.entity';
import { UserAccountStatus } from '../../../domain/enums';
import { MongoHouseholdRepository } from './mongodb-household.repository';
import { HouseholdDocument, HouseholdSchema } from './schemas/household.schema';

describe('Mongo household atomic membership', () => {
  let replica: MongoMemoryReplSet;
  let connection: Connection;
  let model: Model<HouseholdDocument>;
  let repository: MongoHouseholdRepository;

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ launchTimeout: 30_000 }],
    });
    connection = await createConnection(replica.getUri()).asPromise();
    model = connection.model(HouseholdDocument.name, HouseholdSchema);
    repository = new MongoHouseholdRepository(model);
    await repository.onModuleInit();
  }, 60_000);
  beforeEach(async () => {
    await connection.collection('users').insertMany(
      ['owner', 'invited', 'owner-a', 'owner-b', 'other-user'].map((id) => ({
        id,
        normalizedEmail: `${id}@example.com`,
        status: 'active',
      })),
    );
  });
  afterEach(async () => {
    await model?.deleteMany({});
    await connection?.collection('users').deleteMany({});
  });
  afterAll(async () => {
    await connection?.close();
    await replica?.stop();
  });

  it('simultaneous first requests return one household without orphans', async () => {
    const owner = user('owner');
    const first = Household.create(owner);
    const second = Household.create(owner);
    const results = await Promise.all([
      repository.createHouseholdWithOwner(
        first,
        first.createOwnerMembership(owner),
      ),
      repository.createHouseholdWithOwner(
        second,
        second.createOwnerMembership(owner),
      ),
    ]);
    expect(results[0].householdId).toBe(results[1].householdId);
    expect(await model.countDocuments({ entityType: 'HOUSEHOLD' })).toBe(1);
    expect(
      await model.countDocuments({ entityType: 'HOUSEHOLD_MEMBERSHIP' }),
    ).toBe(1);
  });

  it('rejects household creation after the user deletion fence is raised', async () => {
    await connection
      .collection('users')
      .updateOne(
        { id: 'owner' },
        { $set: { deletionFenceExpiresAt: new Date(Date.now() + 60_000) } },
      );
    const owner = user('owner');
    const household = Household.create(owner);

    await expect(
      repository.createHouseholdWithOwner(
        household,
        household.createOwnerMembership(owner),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await model.countDocuments({})).toBe(0);
  });

  it('rejects an invite while the registered invitee account is closing', async () => {
    await connection
      .collection('users')
      .updateOne(
        { id: 'invited' },
        { $set: { deletionFenceExpiresAt: new Date(Date.now() + 60_000) } },
      );
    const owner = user('owner');
    const household = Household.create(owner);
    await repository.createHouseholdWithOwner(
      household,
      household.createOwnerMembership(owner),
    );
    const now = new Date();
    const invite = HouseholdInvite.create({
      householdId: household.id,
      invitedEmail: 'invited@example.com',
      invitedByUserId: 'owner',
      role: 'viewer',
      tokenHash: 'c'.repeat(64),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(repository.saveInvite(invite)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await model.countDocuments({ entityType: 'HOUSEHOLD_INVITE' })).toBe(
      0,
    );
  });

  it('two household invitations can commit only one membership and one accepted invite', async () => {
    const invited = user('invited');
    const attempts = await Promise.all(
      ['owner-a', 'owner-b'].map(async (id) => {
        const owner = user(id);
        const household = Household.create(owner);
        await repository.createHouseholdWithOwner(
          household,
          household.createOwnerMembership(owner),
        );
        const now = new Date();
        const invite = HouseholdInvite.create({
          householdId: household.id,
          invitedEmail: invited.email,
          invitedByUserId: id,
          role: 'editor',
          tokenHash: id.endsWith('a') ? 'a'.repeat(64) : 'b'.repeat(64),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        });
        await repository.saveInvite(invite);
        const membership = HouseholdMembership.create({
          householdId: household.id,
          user: invited,
          role: 'editor',
          now,
        });
        invite.accept(now);
        return { invite, membership };
      }),
    );
    const results = await Promise.allSettled(
      attempts.map(({ invite, membership }) =>
        repository.acceptInvite(invite, membership),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await model.countDocuments({
        entityType: 'HOUSEHOLD_MEMBERSHIP',
        userId: invited.id.toString(),
      }),
    ).toBe(1);
    expect(
      await model.countDocuments({
        entityType: 'HOUSEHOLD_INVITE',
        acceptedAt: { $ne: null },
      }),
    ).toBe(1);
  });

  it('a revoked invite cannot create a membership even with a stale snapshot', async () => {
    const owner = user('owner');
    const household = Household.create(owner);
    await repository.createHouseholdWithOwner(
      household,
      household.createOwnerMembership(owner),
    );
    const invited = user('invited');
    const now = new Date();
    const invite = HouseholdInvite.create({
      householdId: household.id,
      invitedEmail: invited.email,
      invitedByUserId: owner.id.toString(),
      role: 'viewer',
      tokenHash: 'a'.repeat(64),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    await repository.saveInvite(invite);
    const stale = HouseholdInvite.fromPrimitives(invite.toPrimitives());
    invite.revoke();
    await repository.saveInvite(invite);
    stale.accept();
    await expect(
      repository.acceptInvite(
        stale,
        HouseholdMembership.create({
          householdId: household.id,
          user: invited,
          role: 'viewer',
          now,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await repository.findMembershipByUserId(invited.id.toString()),
    ).toBeNull();
  });

  it('cannot create invitation or activity children after a household was deleted', async () => {
    const { household, invite, membership } = await pendingInvite();
    await repository.deleteHouseholdCascade(household.id);
    await expect(repository.saveInvite(invite)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(repository.saveMembership(membership)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await repository.saveActivity(
      HouseholdActivity.create({
        householdId: household.id,
        actorUserId: 'owner',
        type: 'invite_created',
      }),
    );
    expect(await model.countDocuments({ householdId: household.id })).toBe(0);
  });

  it('rejects a stale acceptance as soon as owner deletion closes the household', async () => {
    const { household, invite, membership } = await pendingInvite();
    await repository.saveInvite(invite);
    await model.collection.updateOne(
      { pk: `HOUSEHOLD#${household.id}` },
      { $set: { deleting: 'closing-token' } },
    );
    invite.accept();
    await expect(
      repository.acceptInvite(invite, membership),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await repository.findMembershipByUserId('invited')).toBeNull();
  });

  it('denies owner deletion without modifying data or keeping the household closed when members exist', async () => {
    const { household, invite, membership } = await pendingInvite();
    await repository.saveInvite(invite);
    invite.accept();
    await repository.acceptInvite(invite, membership);
    const count = await model.countDocuments({});
    await expect(
      repository.beginHouseholdDeletion(household.id, 'owner'),
    ).resolves.toEqual({ canDelete: false });
    expect(await repository.findHouseholdById(household.id)).not.toBeNull();
    expect(await model.countDocuments({})).toBe(count);
  });

  it('supports retry after an interrupted deletion without reopening the household', async () => {
    const { household, invite } = await pendingInvite();
    await expect(
      repository.beginHouseholdDeletion(household.id, 'owner'),
    ).resolves.toEqual({ canDelete: true, token: expect.any(String) });
    await expect(
      repository.beginHouseholdDeletion(household.id, 'owner'),
    ).resolves.toEqual({ canDelete: true, token: expect.any(String) });
    await expect(repository.saveInvite(invite)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await repository.findHouseholdById(household.id)).toBeNull();
  });

  it('releases its owner lock when no durable deletion job exists', async () => {
    const { household } = await pendingInvite();
    const lock = await repository.beginHouseholdDeletion(household.id, 'owner');
    expect(lock).toMatchObject({ canDelete: true, token: expect.any(String) });

    await repository.cancelHouseholdDeletion(
      household.id,
      'owner',
      lock.token!,
    );

    expect(await repository.findHouseholdById(household.id)).not.toBeNull();
  });

  it('resumes a cascade after an older attempt already removed the parent', async () => {
    const { household } = await pendingInvite();
    await model.deleteOne({ pk: `HOUSEHOLD#${household.id}` });

    await expect(
      repository.beginHouseholdDeletion(household.id, 'owner'),
    ).resolves.toEqual({ canDelete: true });
    await expect(
      repository.deleteHouseholdCascade(household.id),
    ).resolves.toBeUndefined();
    expect(await model.countDocuments({ householdId: household.id })).toBe(0);
  });

  it('anonymizes only the deleted member references and is idempotent', async () => {
    const { household, invite, membership } = await pendingInvite();
    await repository.saveInvite(invite);
    invite.accept();
    await repository.acceptInvite(invite, membership);
    await repository.saveActivity(
      HouseholdActivity.create({
        householdId: household.id,
        actorUserId: 'invited',
        targetUserId: 'other-user',
        targetLabel: 'Other user',
        type: 'member_removed',
      }),
    );
    await repository.saveActivity(
      HouseholdActivity.create({
        householdId: household.id,
        actorUserId: 'owner',
        targetUserId: 'invited',
        targetLabel: 'Private label',
        type: 'member_removed',
      }),
    );
    await repository.saveActivity(
      HouseholdActivity.create({
        householdId: household.id,
        actorUserId: 'owner',
        targetUserId: 'other-user',
        targetLabel: 'Preserved label',
        type: 'member_removed',
      }),
    );

    await repository.deleteAccountHouseholdData(
      household.id,
      'invited',
      'invited@example.com',
    );
    await repository.deleteAccountHouseholdData(
      household.id,
      'invited',
      'invited@example.com',
    );

    expect(await repository.findMembershipByUserId('invited')).toBeNull();
    const records = await model.find({ householdId: household.id }).lean();
    const savedInvite = records.find(
      (record) => record.entityType === 'HOUSEHOLD_INVITE',
    );
    expect(savedInvite).toEqual(
      expect.objectContaining({
        invitedEmail: 'deleted@example.invalid',
        revokedAt: expect.any(Date),
      }),
    );
    const activities = records.filter(
      (record) => record.entityType === 'HOUSEHOLD_ACTIVITY',
    );
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: 'deleted-user',
          targetUserId: 'other-user',
          targetLabel: 'Other user',
        }),
        expect.objectContaining({
          actorUserId: 'owner',
          targetUserId: 'deleted-user',
          targetLabel: 'Usuario eliminado',
        }),
        expect.objectContaining({
          actorUserId: 'owner',
          targetUserId: 'other-user',
          targetLabel: 'Preserved label',
        }),
      ]),
    );
  });

  it('installs a TTL index for expired household invitations', async () => {
    const indexes = await model.collection.indexes();

    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'household_invite_ttl',
          expireAfterSeconds: 0,
        }),
      ]),
    );
  });

  it.each([1, 2, 3])(
    'serializes invitation acceptance against owner deletion (%s)',
    async () => {
      const { household, invite, membership } = await pendingInvite();
      await repository.saveInvite(invite);
      invite.accept();
      const [deletion, acceptance] = await Promise.allSettled([
        repository.beginHouseholdDeletion(household.id, 'owner'),
        repository.acceptInvite(invite, membership),
      ]);
      expect(deletion.status).toBe('fulfilled');
      const canDelete =
        deletion.status === 'fulfilled' && deletion.value.canDelete;
      if (canDelete) {
        expect(acceptance.status).toBe('rejected');
        expect(await repository.findMembershipByUserId('invited')).toBeNull();
      } else {
        expect(acceptance.status).toBe('fulfilled');
        expect(
          await repository.findMembershipByUserId('invited'),
        ).not.toBeNull();
        expect(await repository.findHouseholdById(household.id)).not.toBeNull();
      }
    },
  );

  async function pendingInvite() {
    const owner = user('owner');
    const household = Household.create(owner);
    await repository.createHouseholdWithOwner(
      household,
      household.createOwnerMembership(owner),
    );
    const invited = user('invited');
    const now = new Date();
    const invite = HouseholdInvite.create({
      householdId: household.id,
      invitedEmail: invited.email,
      invitedByUserId: owner.id.toString(),
      role: 'editor',
      tokenHash: 'a'.repeat(64),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const membership = HouseholdMembership.create({
      householdId: household.id,
      user: invited,
      role: 'editor',
      now,
    });
    return { household, invite, membership };
  }
});

function user(id: string): User {
  return User.fromPrimitives({
    id,
    email: `${id}@example.com`,
    username: id,
    authSubjectIds: [],
    status: UserAccountStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
