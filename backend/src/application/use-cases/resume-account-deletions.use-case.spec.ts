import { UserDao } from '../ports/daos';
import { DeleteAccountUseCase } from './delete-account.use-case';
import { ResumeAccountDeletionsUseCase } from './resume-account-deletions.use-case';

describe('ResumeAccountDeletionsUseCase', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-09-26T12:00:00.000Z')),
  );
  afterEach(() => jest.useRealTimers());

  it('lets a privileged worker resume the oldest durable deletion job', async () => {
    const job = {
      userId: 'user-1',
      email: 'private@example.com',
      username: 'private',
      authSubjectIds: ['cognito-sub'],
      pantryDeletionToken: 'pantry-delete-token',
      startedAt: new Date('2026-09-26T00:00:00.000Z'),
      attempts: 0,
      leaseToken: 'lease-1',
    };
    const userDao = {
      claimPendingAccountDeletion: jest.fn().mockResolvedValue(job),
      deferAccountDeletion: jest.fn(),
    } as unknown as jest.Mocked<UserDao>;
    const deleteAccountUseCase = {
      resume: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<DeleteAccountUseCase>;
    const useCase = new ResumeAccountDeletionsUseCase(
      userDao,
      deleteAccountUseCase,
    );

    await expect(useCase.execute()).resolves.toEqual({ processed: 1 });
    expect(userDao.claimPendingAccountDeletion).toHaveBeenCalledWith(
      new Date('2026-09-26T12:00:00.000Z'),
      new Date('2026-09-26T12:02:00.000Z'),
    );
    expect(deleteAccountUseCase.resume).toHaveBeenCalledWith(job);
  });

  it('defers a failed claim so a poison job cannot starve later jobs', async () => {
    const job = {
      userId: 'user-1',
      email: 'private@example.com',
      username: 'private',
      authSubjectIds: ['cognito-sub'],
      pantryDeletionToken: 'pantry-delete-token',
      startedAt: new Date('2026-09-26T00:00:00.000Z'),
      attempts: 2,
      leaseToken: 'lease-1',
    };
    const userDao = {
      claimPendingAccountDeletion: jest.fn().mockResolvedValue(job),
      deferAccountDeletion: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<UserDao>;
    const deleteAccountUseCase = {
      resume: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-09-26T12:03:00.000Z'));
        throw new Error('temporary failure');
      }),
    } as unknown as jest.Mocked<DeleteAccountUseCase>;
    const useCase = new ResumeAccountDeletionsUseCase(
      userDao,
      deleteAccountUseCase,
    );

    await expect(useCase.execute()).rejects.toThrow('temporary failure');
    expect(userDao.deferAccountDeletion).toHaveBeenCalledWith(
      job,
      new Date('2026-09-26T12:07:00.000Z'),
    );
  });
});
