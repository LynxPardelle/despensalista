import { Model } from 'mongoose';
import { MongoUserDao } from './mongodb-user.dao';
import { UserDocument } from './schemas/user.schema';

describe('MongoUserDao account deletion leases', () => {
  it('moves a claimed job behind other eligible work before external effects', async () => {
    const leaseExpiresAt = new Date('2026-09-26T12:02:00.000Z');
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      _id: 'user-1',
      userId: 'user-1',
      email: 'private@example.com',
      username: 'private',
      authSubjectIds: ['subject-1'],
      pantryDeletionToken: 'pantry-delete-token',
      startedAt: new Date('2026-09-26T00:00:00.000Z'),
      nextAttemptAt: leaseExpiresAt,
      attempts: 0,
      leaseToken: 'lease-1',
      leaseExpiresAt,
    });
    const model = {
      db: {
        collection: jest.fn().mockReturnValue({ findOneAndUpdate }),
      },
    } as unknown as Model<UserDocument>;
    const dao = new MongoUserDao(model);

    await expect(
      dao.claimPendingAccountDeletion(
        new Date('2026-09-26T12:00:00.000Z'),
        leaseExpiresAt,
      ),
    ).resolves.toMatchObject({ authUsernamesBySubject: {} });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({ nextAttemptAt: leaseExpiresAt }),
      }),
      expect.objectContaining({
        sort: { nextAttemptAt: 1, startedAt: 1 },
        returnDocument: 'after',
      }),
    );
  });
});
