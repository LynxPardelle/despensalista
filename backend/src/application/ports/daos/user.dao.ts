import { User } from '../../../domain/entities/user.entity';
import { HouseholdRole } from '../../../domain/entities/household.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';

export interface AccountDeletionContext {
  householdId?: string;
  householdRole?: HouseholdRole;
}

export interface AccountDeletionStartContext extends AccountDeletionContext {
  householdDeletionToken?: string;
}

export interface AccountDeletionJob extends AccountDeletionContext {
  userId: string;
  email: string;
  username: string;
  authSubjectIds: string[];
  pantryDeletionToken: string;
  startedAt: Date;
  attempts?: number;
  leaseToken?: string;
}

export interface UserDao {
  save(user: User): Promise<User>;
  findById(id: UserId): Promise<User | null>;
  findByAuthSubject(authSubjectId: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  beginAccountDeletion(
    id: UserId,
    expiresAt: Date,
    context?: AccountDeletionStartContext,
  ): Promise<AccountDeletionJob | null>;
  findPendingAccountDeletions(limit: number): Promise<AccountDeletionJob[]>;
  claimPendingAccountDeletion(
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<AccountDeletionJob | null>;
  deferAccountDeletion(
    job: AccountDeletionJob,
    nextAttemptAt: Date,
  ): Promise<void>;
  delete(id: UserId): Promise<void>;
}
