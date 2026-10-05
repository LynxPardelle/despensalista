import { Inject, Injectable } from '@nestjs/common';
import { UserDao } from '../ports/daos';
import { USER_DAO } from '../tokens';
import { DeleteAccountUseCase } from './delete-account.use-case';

const LEASE_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MINUTES = 60;

@Injectable()
export class ResumeAccountDeletionsUseCase {
  constructor(
    @Inject(USER_DAO) private readonly userDao: UserDao,
    private readonly deleteAccountUseCase: DeleteAccountUseCase,
  ) {}

  async execute(): Promise<{ processed: number }> {
    const now = new Date();
    const job = await this.userDao.claimPendingAccountDeletion(
      now,
      new Date(now.getTime() + LEASE_MS),
    );
    if (!job) return { processed: 0 };

    try {
      await this.deleteAccountUseCase.resume(job);
    } catch (error) {
      const minutes = Math.min(
        2 ** Math.min(job.attempts ?? 0, 10),
        MAX_BACKOFF_MINUTES,
      );
      await this.userDao.deferAccountDeletion(
        job,
        new Date(Date.now() + minutes * 60 * 1000),
      );
      throw error;
    }
    return { processed: 1 };
  }
}
