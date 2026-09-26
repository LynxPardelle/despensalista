import { InjectModel } from '@nestjs/mongoose';
import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientSession, Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { UserDao } from '../../../application/ports/daos';
import { User, UserPrimitives } from '../../../domain/entities/user.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserDocument } from './schemas/user.schema';

type PersistedUser = UserPrimitives & {
  normalizedEmail: string;
  normalizedUsername: string;
  deletionFenceExpiresAt?: Date;
};

type AccountRevocationRecord = {
  _id: string;
  expiresAt: Date;
};

const ACCOUNT_DELETION_FENCE_MS = 24 * 60 * 60 * 1000;

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
  ): Promise<User | null> {
    const session = await this.userModel.db.startSession();
    let user: PersistedUser | null = null;

    try {
      await session.withTransaction(async () => {
        user = await this.userModel
          .findOneAndUpdate(
            { id: id.toString() },
            { $set: { deletionFenceExpiresAt: expiresAt } },
            { new: true, session },
          )
          .lean()
          .exec();
        if (user) await this.writeRevocations(user, expiresAt, session);
      });
    } finally {
      await session.endSession();
    }

    return user ? this.toDomain(user) : null;
  }

  async delete(id: UserId): Promise<void> {
    const session = await this.userModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        const user = (await this.userModel
          .findOne({ id: id.toString() })
          .session(session)
          .lean()
          .exec()) as PersistedUser | null;
        if (!user) return;

        await this.writeRevocations(
          user,
          new Date(Date.now() + ACCOUNT_DELETION_FENCE_MS),
          session,
        );
        await this.userModel
          .deleteOne({ id: id.toString() }, { session })
          .exec();
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

  private async writeRevocations(
    user: PersistedUser,
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
      status: user.status,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt),
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
