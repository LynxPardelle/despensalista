import { InjectModel } from '@nestjs/mongoose';
import {
  ConflictException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientSession, Model } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import {
  AccountDeletionJob,
  AccountDeletionStartContext,
  UserDao,
} from '../../../application/ports/daos';
import { HouseholdRole } from '../../../domain/entities/household.entity';
import { User, UserPrimitives } from '../../../domain/entities/user.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserDocument } from './schemas/user.schema';

type PersistedUser = Omit<UserPrimitives, 'deletionFenceExpiresAt'> & {
  normalizedEmail: string;
  normalizedUsername: string;
  deletionFenceExpiresAt?: Date;
};

type AccountRevocationRecord = {
  _id: string;
  expiresAt: Date;
};

type AccountDeletionJobRecord = {
  _id: string;
  userId: string;
  email: string;
  username: string;
  authSubjectIds: string[];
  authUsernamesBySubject?: Record<string, string>;
  pantryDeletionToken: string;
  householdId?: string;
  householdRole?: HouseholdRole;
  startedAt: Date;
  nextAttemptAt: Date;
  attempts: number;
  leaseToken?: string;
  leaseExpiresAt?: Date;
};

const ACCOUNT_DELETION_FENCE_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_DELETION_INITIAL_RETRY_DELAY_MS = 2 * 60 * 1000;

@Injectable()
export class MongoUserDao implements UserDao, OnModuleInit {
  constructor(
    @InjectModel(UserDocument.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.revocations.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'account_revocation_ttl' },
    );
    await this.deletionJobs.createIndex(
      { nextAttemptAt: 1, startedAt: 1 },
      { name: 'account_deletion_next_attempt' },
    );
  }

  async save(user: User): Promise<User> {
    const primitives = user.toPrimitives();
    const normalizedEmail = normalizeEmail(primitives.email);
    const normalizedUsername = normalizeUsername(primitives.username);
    const now = new Date();
    const fenceIds = accountFenceIds(primitives);
    const session = await this.userModel.db.startSession();
    let savedUser: PersistedUser | null = null;

    try {
      await session.withTransaction(async () => {
        const revocation = await this.revocations.findOne(
          { _id: { $in: fenceIds }, expiresAt: { $gt: now } },
          { session },
        );
        if (revocation) throw accountDeletedError();

        savedUser = await this.userModel
          .findOneAndUpdate(
            {
              id: primitives.id,
              $or: [
                { deletionFenceExpiresAt: { $exists: false } },
                { deletionFenceExpiresAt: { $lte: now } },
              ],
            },
            {
              $set: {
                ...primitives,
                normalizedEmail,
                normalizedUsername,
              },
            },
            { new: true, upsert: true, session },
          )
          .lean()
          .exec();
      });
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        ((error as { code?: number }).code === 11000 &&
          (await this.hasActiveDeletionFence(primitives.id, fenceIds, now)))
      ) {
        throw accountDeletedError();
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (!savedUser) throw accountDeletedError();

    return this.toDomain(savedUser);
  }

  async findById(id: UserId): Promise<User | null> {
    const user = await this.userModel
      .findOne({ id: id.toString() })
      .lean()
      .exec();

    return user ? this.toDomain(user) : null;
  }

  async findByAuthSubject(authSubjectId: string): Promise<User | null> {
    const user = await this.userModel
      .findOne({ authSubjectIds: normalizeAuthSubjectId(authSubjectId) })
      .lean()
      .exec();

    return user ? this.toDomain(user) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const user = await this.userModel
      .findOne({ normalizedEmail: normalizeEmail(email) })
      .lean()
      .exec();

    return user ? this.toDomain(user) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const user = await this.userModel
      .findOne({ normalizedUsername: normalizeUsername(username) })
      .lean()
      .exec();

    return user ? this.toDomain(user) : null;
  }

  async beginAccountDeletion(
    id: UserId,
    expiresAt: Date,
    context: AccountDeletionStartContext = {},
  ): Promise<AccountDeletionJob | null> {
    const session = await this.userModel.db.startSession();
    let job: AccountDeletionJobRecord | null = null;

    try {
      await session.withTransaction(async () => {
        job = await this.deletionJobs.findOne(
          { _id: id.toString() },
          { session },
        );
        if (job) return;

        await this.validateAccountDeletionContext(id, context, session);

        const user = await this.userModel
          .findOneAndUpdate(
            { id: id.toString() },
            { $set: { deletionFenceExpiresAt: expiresAt } },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!user) return;

        await this.writeRevocations(user, expiresAt, session);
        const startedAt = new Date();
        job = {
          _id: user.id,
          userId: user.id,
          email: user.email,
          username: user.username,
          authSubjectIds: normalizeAuthSubjectIds(user.authSubjectIds ?? []),
          authUsernamesBySubject: normalizeAuthUsernamesBySubject(
            user.authUsernamesBySubject ?? {},
          ),
          pantryDeletionToken: randomUUID(),
          householdId: context.householdId,
          householdRole: context.householdRole,
          startedAt,
          nextAttemptAt: new Date(
            startedAt.getTime() + ACCOUNT_DELETION_INITIAL_RETRY_DELAY_MS,
          ),
          attempts: 0,
        };
        await this.deletionJobs.insertOne(job, { session });
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const winner = await this.deletionJobs.findOne({ _id: id.toString() });
        return winner ? this.toAccountDeletionJob(winner) : null;
      }
      throw error;
    } finally {
      await session.endSession();
    }

    return job ? this.toAccountDeletionJob(job) : null;
  }

  async findPendingAccountDeletions(
    limit: number,
  ): Promise<AccountDeletionJob[]> {
    const jobs = await this.deletionJobs
      .find({})
      .sort({ startedAt: 1 })
      .limit(Math.min(Math.max(1, Math.trunc(limit)), 10))
      .toArray();
    return jobs.map((job) => this.toAccountDeletionJob(job));
  }

  async claimPendingAccountDeletion(
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<AccountDeletionJob | null> {
    const job = await this.deletionJobs.findOneAndUpdate(
      {
        nextAttemptAt: { $lte: now },
        $or: [
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          leaseToken: randomUUID(),
          leaseExpiresAt,
          nextAttemptAt: leaseExpiresAt,
        },
      },
      { sort: { nextAttemptAt: 1, startedAt: 1 }, returnDocument: 'after' },
    );
    return job ? this.toAccountDeletionJob(job) : null;
  }

  async deferAccountDeletion(
    job: AccountDeletionJob,
    nextAttemptAt: Date,
  ): Promise<void> {
    if (!job.leaseToken) throw new Error('Account deletion lease is required');
    const result = await this.deletionJobs.updateOne(
      { _id: job.userId, leaseToken: job.leaseToken },
      {
        $set: { nextAttemptAt },
        $inc: { attempts: 1 },
        $unset: { leaseToken: '', leaseExpiresAt: '' },
      },
    );
    if (result.matchedCount !== 1) {
      throw new ConflictException('Account deletion lease was lost');
    }
  }

  async delete(id: UserId): Promise<void> {
    const session = await this.userModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        const job = await this.deletionJobs.findOne(
          { _id: id.toString() },
          { session },
        );
        const user = (await this.userModel
          .findOne({ id: id.toString() })
          .session(session)
          .lean()
          .exec()) as PersistedUser | null;
        if (!job && !user) return;

        await this.writeRevocations(
          {
            id: job?.userId ?? user!.id,
            authSubjectIds: job?.authSubjectIds ?? user!.authSubjectIds,
          },
          new Date(Date.now() + ACCOUNT_DELETION_FENCE_MS),
          session,
        );
        if (job) {
          const pantryDeletion = await this.pantryQuotas.deleteOne(
            {
              _id: id.toString(),
              deleting: true,
              deletionToken: job.pantryDeletionToken,
            },
            { session },
          );
          if (pantryDeletion.deletedCount !== 1) {
            throw new ConflictException('Pantry deletion lock was lost');
          }
        }
        await this.userModel
          .deleteOne({ id: id.toString() }, { session })
          .exec();
        await this.deletionJobs.deleteOne({ _id: id.toString() }, { session });
      });
    } finally {
      await session.endSession();
    }
  }

  private get revocations() {
    return this.userModel.db.collection<AccountRevocationRecord>(
      'account_revocations',
    );
  }

  private get deletionJobs() {
    return this.userModel.db.collection<AccountDeletionJobRecord>(
      'account_deletion_jobs',
    );
  }

  private get households() {
    return this.userModel.db.collection('households');
  }

  private get pantryQuotas() {
    return this.userModel.db.collection<{
      _id: string;
      deleting: boolean;
      deletionToken: string;
    }>('pantry_quotas');
  }

  private async writeRevocations(
    user: Pick<UserPrimitives, 'id' | 'authSubjectIds'>,
    expiresAt: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.revocations.bulkWrite(
      accountFenceIds(user).map((_id) => ({
        updateOne: {
          filter: { _id },
          update: { $set: { expiresAt } },
          upsert: true,
        },
      })),
      { session },
    );
  }

  private toAccountDeletionJob(
    job: AccountDeletionJobRecord,
  ): AccountDeletionJob {
    return {
      userId: job.userId,
      email: job.email,
      username: job.username,
      authSubjectIds: normalizeAuthSubjectIds(job.authSubjectIds ?? []),
      authUsernamesBySubject: normalizeAuthUsernamesBySubject(
        job.authUsernamesBySubject ?? {},
      ),
      pantryDeletionToken: job.pantryDeletionToken,
      householdId: job.householdId,
      householdRole: job.householdRole,
      startedAt: new Date(job.startedAt),
      attempts: job.attempts ?? 0,
      leaseToken: job.leaseToken,
    };
  }

  private async validateAccountDeletionContext(
    id: UserId,
    context: AccountDeletionStartContext,
    session: ClientSession,
  ): Promise<void> {
    const userId = id.toString();
    if (!context.householdId || !context.householdRole) {
      const membership = await this.households.findOne(
        { entityType: 'HOUSEHOLD_MEMBERSHIP', userId },
        { projection: { _id: 1 }, session },
      );
      if (membership) {
        throw new ConflictException('Household membership changed; retry');
      }
      return;
    }

    const membership = await this.households.updateOne(
      {
        entityType: 'HOUSEHOLD_MEMBERSHIP',
        userId,
        householdId: context.householdId,
        role: context.householdRole,
      },
      { $inc: { accountDeletionVersion: 1 } },
      { session },
    );
    if (membership.matchedCount !== 1) {
      throw new ConflictException('Household membership changed; retry');
    }
    if (context.householdRole !== 'owner') return;
    if (!context.householdDeletionToken) {
      throw new ConflictException('Household deletion lock was lost; retry');
    }
    const parent = await this.households.updateOne(
      {
        pk: `HOUSEHOLD#${context.householdId}`,
        ownerUserId: userId,
        deleting: context.householdDeletionToken,
      },
      { $inc: { accountDeletionVersion: 1 } },
      { session },
    );
    if (parent.matchedCount !== 1) {
      throw new ConflictException('Household deletion lock was lost; retry');
    }
  }

  private async hasActiveDeletionFence(
    userId: string,
    fenceIds: string[],
    now: Date,
  ): Promise<boolean> {
    const [revocation, deletingUser] = await Promise.all([
      this.revocations.findOne({
        _id: { $in: fenceIds },
        expiresAt: { $gt: now },
      }),
      this.userModel
        .exists({ id: userId, deletionFenceExpiresAt: { $gt: now } })
        .exec(),
    ]);
    return Boolean(revocation || deletingUser);
  }

  private toDomain(user: PersistedUser): User {
    return User.fromPrimitives({
      id: user.id,
      email: user.email,
      username: user.username,
      authSubjectIds: user.authSubjectIds ?? [],
      authUsernamesBySubject: normalizeAuthUsernamesBySubject(
        user.authUsernamesBySubject ?? {},
      ),
      status: user.status,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt),
      ...(user.deletionFenceExpiresAt
        ? { deletionFenceExpiresAt: new Date(user.deletionFenceExpiresAt) }
        : {}),
    });
  }
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
  return [...new Set(authSubjectIds.map(normalizeAuthSubjectId))].filter(
    Boolean,
  );
}

function normalizeAuthUsernamesBySubject(
  authUsernamesBySubject: Record<string, string>,
): Record<string, string> {
  const normalized: [string, string][] = [];
  for (const [subjectId, username] of Object.entries(authUsernamesBySubject)) {
    const normalizedSubjectId = subjectId.trim();
    const normalizedUsername = username.trim();
    if (normalizedSubjectId && normalizedUsername) {
      normalized.push([normalizedSubjectId, normalizedUsername]);
    }
  }
  return Object.fromEntries(normalized);
}

function accountFenceIds(
  user: Pick<UserPrimitives, 'id' | 'authSubjectIds'>,
): string[] {
  return [...new Set([user.id, ...(user.authSubjectIds ?? [])])].map((value) =>
    createHash('sha256').update(value.trim()).digest('hex'),
  );
}

function accountDeletedError(): UnauthorizedException {
  return new UnauthorizedException('Account deletion is in progress');
}
