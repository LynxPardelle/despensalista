import { ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, ClientSession, Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  Household,
  HouseholdActivity,
  HouseholdActivityPrimitives,
  HouseholdInvite,
  HouseholdInvitePrimitives,
  HouseholdMembership,
  HouseholdMembershipPrimitives,
  HouseholdPrimitives,
} from '../../../domain/entities/household.entity';
import {
  HouseholdDeletionLock,
  HouseholdMemberLimitError,
  HouseholdRepository,
  HouseholdSwitchConflictError,
  HouseholdSwitchState,
} from '../../../domain/repositories/household.repository';
import { HouseholdDocument } from './schemas/household.schema';

const ANONYMIZED_USER_ID = 'deleted-user';
const ANONYMIZED_EMAIL = 'deleted@example.invalid';
const ANONYMIZED_LABEL = 'Usuario eliminado';
const PRIVACY_BATCH_SIZE = 100;

type ActiveUserRecord = {
  id: string;
  normalizedEmail?: string;
  status: string;
  deletionFenceExpiresAt?: Date;
  householdMutationVersion?: number;
  accountDeletionCancellationVersion?: number;
};

type HouseholdRecord = HouseholdPrimitives & {
  pk: string;
  entityType: 'HOUSEHOLD';
};

type MembershipRecord = HouseholdMembershipPrimitives & {
  pk: string;
  entityType: 'HOUSEHOLD_MEMBERSHIP';
  createdAt: Date;
};

type InviteRecord = HouseholdInvitePrimitives & {
  pk: string;
  entityType: 'HOUSEHOLD_INVITE';
};

type ActivityRecord = HouseholdActivityPrimitives & {
  pk: string;
  entityType: 'HOUSEHOLD_ACTIVITY';
  updatedAt: Date;
};

@Injectable()
export class MongoHouseholdRepository
  implements HouseholdRepository, OnModuleInit
{
  constructor(
    @InjectModel(HouseholdDocument.name)
    private readonly householdModel: Model<HouseholdDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Do not serve membership writes until the uniqueness invariant is enforced.
    await this.householdModel.createIndexes();
  }

  async createHouseholdWithOwner(
    household: Household,
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership> {
    const activity = HouseholdActivity.create({
      householdId: household.id,
      actorUserId: membership.userId,
      type: 'household_created',
    });
    const session = await this.householdModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.assertActiveUsers([membership.userId], session);
        await this.householdModel.create(
          [
            {
              ...this.toHouseholdRecord(household),
              creationActivityId: activity.id,
            },
            this.toMembershipRecord(membership),
            this.toActivityRecord(activity),
          ],
          { session, ordered: true },
        );
      });
      return membership;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const winner = await this.findMembershipByUserId(membership.userId);
      if (winner) return winner;
      throw new ConflictException('Household changed; refresh and retry');
    } finally {
      await session.endSession();
    }
  }

  async acceptInvite(
    invite: HouseholdInvite,
    membership: HouseholdMembership,
    memberLimit: number,
    previous?: HouseholdMembership,
  ): Promise<HouseholdMembership> {
    const inviteRecord = this.toInviteRecord(invite);
    if (previous) {
      if (
        previous.userId !== membership.userId ||
        previous.householdId === membership.householdId ||
        membership.householdId !== invite.householdId ||
        membership.role !== invite.role ||
        membership.role === 'owner' ||
        membership.toPrimitives().email !== invite.invitedEmail
      ) {
        throw new HouseholdSwitchConflictError();
      }
      inviteRecord.acceptedByUserId = membership.userId;
      inviteRecord.acceptedFromHouseholdId = previous.householdId;
    }
    const session = await this.householdModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.assertActiveUsers(
          [membership.userId, inviteRecord.invitedByUserId],
          session,
        );
        const household = await this.householdModel
          .updateOne(
            {
              pk: householdKey(invite.householdId),
              deleting: { $exists: false },
            },
            { $inc: { mutationVersion: 1 } },
            { session },
          )
          .exec();
        if (household.matchedCount !== 1)
          throw new ConflictException('Household no longer exists');
        await this.assertMemberSpace(
          invite.householdId,
          memberLimit,
          session,
          membership.userId,
        );
        const accepted = await this.householdModel
          .updateOne(
            {
              pk: inviteKey(invite.id),
              tokenHash: inviteRecord.tokenHash,
              invitedEmail: inviteRecord.invitedEmail,
              invitedByUserId: inviteRecord.invitedByUserId,
              householdId: inviteRecord.householdId,
              role: inviteRecord.role,
              acceptedAt: null,
              revokedAt: null,
              privacyRedacted: { $ne: true },
              expiresAt: { $gt: new Date() },
            },
            inviteRecord,
            { session },
          )
          .exec();
        if (accepted.matchedCount !== 1)
          throw new ConflictException('Invitation changed; refresh and retry');
        if (previous) {
          await this.switchMembership(previous, membership, session);
          return;
        }
        await this.householdModel
          .updateOne(
            {
              entityType: 'HOUSEHOLD_MEMBERSHIP',
              userId: membership.userId,
              householdId: membership.householdId,
              role: membership.role,
            },
            { $setOnInsert: this.toMembershipRecord(membership) },
            { upsert: true, session },
          )
          .exec();
      });
      return membership;
    } catch (error) {
      if (
        previous &&
        (error instanceof ConflictException ||
          (error as { code?: number }).code === 11000)
      ) {
        throw new HouseholdSwitchConflictError();
      }
      if ((error as { code?: number }).code === 11000)
        throw new ConflictException('User already belongs to a household');
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async registerHouseholdSwitchCandidate(userId: string): Promise<void> {
    const session = await this.householdModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.assertActiveUsers([userId], session);
        const now = new Date();
        await this.householdModel
          .updateOne(
            { pk: switchStateKey(userId) },
            {
              $setOnInsert: {
                entityType: 'HOUSEHOLD_SWITCH_STATE',
                userId,
                pristine: true,
                createdAt: now,
                updatedAt: now,
              },
            },
            { upsert: true, session },
          )
          .exec();
      });
    } finally {
      await session.endSession();
    }
  }

  async markHouseholdUsed(userId: string): Promise<void> {
    const alreadyUsed = await this.householdModel
      .exists({ pk: switchStateKey(userId), pristine: false })
      .exec();
    if (alreadyUsed) return;

    const session = await this.householdModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.assertActiveUsers([userId], session);
        await this.updateSwitchState(userId, session, false, false);
      });
    } finally {
      await session.endSession();
    }
  }

  async getHouseholdSwitchState(userId: string): Promise<HouseholdSwitchState> {
    const record = await this.householdModel
      .findOne({ pk: switchStateKey(userId) })
      .lean()
      .exec();
    return {
      pristine: record?.pristine === true,
      contextRequired: record?.contextRequired === true,
    };
  }

  async canSwitchFrom(previous: HouseholdMembership): Promise<boolean> {
    if (previous.role !== 'owner') return true;
    if (!(await this.getHouseholdSwitchState(previous.userId)).pristine)
      return false;
    const parent = await this.householdModel
      .findOne({
        pk: householdKey(previous.householdId),
        ownerUserId: previous.userId,
        deleting: { $exists: false },
        creationActivityId: { $exists: true },
      })
      .lean()
      .exec();
    if (!parent) return false;
    return !(await this.householdModel
      .exists({
        entityType: 'HOUSEHOLD_MEMBERSHIP',
        householdId: previous.householdId,
        userId: { $ne: previous.userId },
      })
      .exec());
  }

  private async switchMembership(
    previous: HouseholdMembership,
    membership: HouseholdMembership,
    session: ClientSession,
  ): Promise<void> {
    const isOwner = previous.role === 'owner';
    const { joinedAt, updatedAt, contextVersion } = previous.toPrimitives();
    const parent = await this.householdModel
      .findOneAndUpdate(
        {
          pk: householdKey(previous.householdId),
          deleting: { $exists: false },
          ...(isOwner
            ? {
                ownerUserId: previous.userId,
                creationActivityId: { $exists: true },
              }
            : { ownerUserId: { $ne: previous.userId } }),
        },
        { $inc: { mutationVersion: 1 } },
        { session },
      )
      .lean()
      .exec();
    if (!parent) throw new HouseholdSwitchConflictError();

    if (isOwner) {
      const otherMember = await this.householdModel
        .exists({
          entityType: 'HOUSEHOLD_MEMBERSHIP',
          householdId: previous.householdId,
          userId: { $ne: previous.userId },
        })
        .session(session)
        .exec();
      if (otherMember || !parent.creationActivityId)
        throw new HouseholdSwitchConflictError();
      const activity = await this.householdModel
        .deleteOne(
          {
            pk: activityKey(parent.creationActivityId),
            householdId: previous.householdId,
            actorUserId: previous.userId,
            type: 'household_created',
          },
          { session },
        )
        .exec();
      if (activity.deletedCount !== 1) throw new HouseholdSwitchConflictError();
      await this.householdModel
        .deleteOne({ pk: parent.pk }, { session })
        .exec();
    }

    const moved = await this.householdModel
      .updateOne(
        {
          pk: membershipKey(previous.householdId, previous.userId),
          role: previous.role,
          joinedAt,
          updatedAt,
          contextVersion: contextVersion ?? { $exists: false },
        },
        { $set: this.toMembershipRecord(membership) },
        { session },
      )
      .exec();
    if (moved.matchedCount !== 1) throw new HouseholdSwitchConflictError();
    await this.updateSwitchState(previous.userId, session, isOwner, true);
  }

  private async updateSwitchState(
    userId: string,
    session: ClientSession,
    requirePristine: boolean,
    setContextRequired: boolean,
  ): Promise<void> {
    const now = new Date();
    const changed = await this.householdModel
      .updateOne(
        {
          pk: switchStateKey(userId),
          ...(requirePristine && { pristine: true }),
        },
        {
          $set: {
            updatedAt: now,
            pristine: false,
            ...(setContextRequired && { contextRequired: true }),
          },
          $setOnInsert: {
            entityType: 'HOUSEHOLD_SWITCH_STATE',
            userId,
            createdAt: now,
          },
        },
        { upsert: !requirePristine, session },
      )
      .exec();
    if (requirePristine && changed.matchedCount !== 1)
      throw new HouseholdSwitchConflictError();
  }

  async saveHousehold(household: Household): Promise<Household> {
    const record = this.toHouseholdRecord(household);
    const session = await this.householdModel.db.startSession();
    try {
      return await session.withTransaction(async () => {
        await this.assertActiveUsers([household.ownerUserId], session);
        const saved = await this.householdModel
          .findOneAndUpdate({ pk: record.pk }, record, {
            new: true,
            upsert: true,
            session,
          })
          .lean()
          .exec();
        return this.toHousehold(saved as HouseholdRecord);
      });
    } finally {
      await session.endSession();
    }
  }

  async saveMembership(
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership> {
    const record = this.toMembershipRecord(membership);
    return this.writeOpenHouseholdChild(
      membership.householdId,
      [membership.userId],
      async (session) => {
        const saved = await this.householdModel
          .findOneAndUpdate({ pk: record.pk }, record, {
            new: true,
            session,
          })
          .lean()
          .exec();
        if (!saved)
          throw new ConflictException('Household membership no longer exists');
        return this.toMembership(saved as MembershipRecord);
      },
    );
  }

  async saveInvite(
    invite: HouseholdInvite,
    memberLimit?: number,
  ): Promise<HouseholdInvite> {
    const record = this.toInviteRecord(invite);
    return this.writeOpenHouseholdChild(
      invite.householdId,
      [record.invitedByUserId],
      async (session) => {
        const invitedUser = await this.users.findOne(
          { normalizedEmail: record.invitedEmail },
          { projection: { id: 1 }, session },
        );
        if (invitedUser)
          await this.assertActiveUsers([invitedUser.id], session);
        if (!record.revokedAt) {
          if (memberLimit !== undefined)
            await this.assertMemberSpace(
              invite.householdId,
              memberLimit,
              session,
            );
          await this.householdModel.create([record], { session });
          return invite;
        }
        const saved = await this.householdModel
          .findOneAndUpdate(
            {
              pk: record.pk,
              acceptedAt: null,
              privacyRedacted: { $ne: true },
            },
            record,
            { new: true, session },
          )
          .lean()
          .exec();
        if (!saved)
          throw new ConflictException('Invitation changed; refresh and retry');
        return this.toInvite(saved as InviteRecord);
      },
    );
  }

  async saveActivity(activity: HouseholdActivity): Promise<HouseholdActivity> {
    const record = this.toActivityRecord(activity);
    try {
      return await this.writeOpenHouseholdChild(
        activity.householdId,
        [record.actorUserId, record.targetUserId],
        async (session) => {
          const saved = await this.householdModel
            .findOneAndUpdate({ pk: record.pk }, record, {
              new: true,
              upsert: true,
              session,
            })
            .lean()
            .exec();
          return this.toActivity(saved as ActivityRecord);
        },
      );
    } catch (error) {
      // Deletion removes the stream; a completed operation need not recreate it.
      if (!(error instanceof ConflictException)) throw error;
      return activity;
    }
  }

  async findHouseholdById(id: string): Promise<Household | null> {
    const record = await this.householdModel
      .findOne({ pk: householdKey(id), deleting: { $exists: false } })
      .lean()
      .exec();

    return record ? this.toHousehold(record as HouseholdRecord) : null;
  }

  async findMembershipByUserId(
    userId: string,
  ): Promise<HouseholdMembership | null> {
    const record = await this.householdModel
      .findOne({ entityType: 'HOUSEHOLD_MEMBERSHIP', userId })
      .lean()
      .exec();

    return record ? this.toMembership(record as MembershipRecord) : null;
  }

  async findMembershipByHouseholdAndUserId(
    householdId: string,
    userId: string,
  ): Promise<HouseholdMembership | null> {
    const record = await this.householdModel
      .findOne({ pk: membershipKey(householdId, userId) })
      .lean()
      .exec();

    return record ? this.toMembership(record as MembershipRecord) : null;
  }

  async findMembersByHouseholdId(
    householdId: string,
  ): Promise<HouseholdMembership[]> {
    const records = await this.householdModel
      .find({ entityType: 'HOUSEHOLD_MEMBERSHIP', householdId })
      .sort({ joinedAt: 1 })
      .lean()
      .exec();

    return records.map((record) =>
      this.toMembership(record as MembershipRecord),
    );
  }

  async deleteMembership(householdId: string, userId: string): Promise<void> {
    await this.householdModel
      .deleteOne({ pk: membershipKey(householdId, userId) })
      .exec();
  }

  async findActiveInvitesByHouseholdId(
    householdId: string,
    now: Date,
  ): Promise<HouseholdInvite[]> {
    const records = await this.householdModel
      .find({
        entityType: 'HOUSEHOLD_INVITE',
        householdId,
        expiresAt: { $gt: now },
        $and: [
          {
            $or: [{ acceptedAt: { $exists: false } }, { acceptedAt: null }],
          },
          {
            $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }],
          },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean()
      .exec();

    return records
      .map((record) => this.toInvite(record as InviteRecord))
      .filter((invite) => invite.isActive(now));
  }

  async findInviteById(id: string): Promise<HouseholdInvite | null> {
    const record = await this.householdModel
      .findOne({ pk: inviteKey(id) })
      .lean()
      .exec();

    return record ? this.toInvite(record as InviteRecord) : null;
  }

  async findInviteByTokenHash(
    tokenHash: string,
  ): Promise<HouseholdInvite | null> {
    const record = await this.householdModel
      .findOne({ entityType: 'HOUSEHOLD_INVITE', tokenHash })
      .lean()
      .exec();

    return record ? this.toInvite(record as InviteRecord) : null;
  }

  async findActivitiesByHouseholdId(
    householdId: string,
    limit: number,
  ): Promise<HouseholdActivity[]> {
    const records = await this.householdModel
      .find({ entityType: 'HOUSEHOLD_ACTIVITY', householdId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    return records.map((record) => this.toActivity(record as ActivityRecord));
  }

  async deleteAccountHouseholdReferences(
    userId: string,
    email: string,
  ): Promise<void> {
    const normalizedEmail = email.trim().toLocaleLowerCase('en-US');
    let lastPk: string | undefined;

    while (true) {
      const records = await this.householdModel
        .find({
          ...(lastPk ? { pk: { $gt: lastPk } } : {}),
          $or: [
            {
              entityType: 'HOUSEHOLD_ACTIVITY',
              $or: [{ actorUserId: userId }, { targetUserId: userId }],
            },
            {
              entityType: 'HOUSEHOLD_INVITE',
              $or: [
                { invitedByUserId: userId },
                { invitedEmail: normalizedEmail },
                { acceptedByUserId: userId },
              ],
            },
            { entityType: 'HOUSEHOLD_MEMBERSHIP', userId },
            { entityType: 'HOUSEHOLD_SWITCH_STATE', userId },
          ],
        })
        .sort({ pk: 1 })
        .limit(PRIVACY_BATCH_SIZE)
        .lean()
        .exec();
      if (records.length === 0) break;

      const session = await this.householdModel.db.startSession();
      try {
        await session.withTransaction(async () => {
          await this.householdModel.bulkWrite(
            records.map((record) =>
              this.accountDeletionChange(
                record as unknown as Record<string, unknown>,
                userId,
                normalizedEmail,
              ),
            ),
            { ordered: true, session },
          );
        });
      } finally {
        await session.endSession();
      }
      lastPk = records.at(-1)?.pk;
    }
  }

  async beginHouseholdDeletion(
    householdId: string,
    ownerUserId: string,
  ): Promise<HouseholdDeletionLock> {
    const session = await this.householdModel.db.startSession();
    let canDelete = false;
    let parentLocked = true;
    const token = randomUUID();
    try {
      await session.withTransaction(async () => {
        const closed = await this.householdModel
          .updateOne(
            { pk: householdKey(householdId), ownerUserId },
            { $set: { deleting: token } },
            { session },
          )
          .exec();
        if (closed.matchedCount !== 1) {
          const parent = await this.householdModel
            .findOne({ pk: householdKey(householdId) })
            .session(session)
            .lean()
            .exec();
          if (parent)
            throw new ConflictException('Household changed; refresh and retry');
          parentLocked = false;
        }
        const otherMember = await this.householdModel
          .findOne({
            entityType: 'HOUSEHOLD_MEMBERSHIP',
            householdId,
            userId: { $ne: ownerUserId },
          })
          .session(session)
          .lean()
          .exec();
        canDelete = !otherMember;
        if (otherMember) {
          await this.householdModel
            .updateOne(
              { pk: householdKey(householdId), deleting: token },
              { $unset: { deleting: '' } },
              { session },
            )
            .exec();
        }
      });
      return {
        canDelete,
        ...(canDelete && parentLocked ? { token } : {}),
      };
    } finally {
      await session.endSession();
    }
  }

  async cancelHouseholdDeletion(
    householdId: string,
    ownerUserId: string,
    token: string,
  ): Promise<void> {
    const session = await this.householdModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        const job = await this.deletionJobs.findOne(
          { _id: ownerUserId },
          { projection: { _id: 1 }, session },
        );
        if (job) return;
        const user = await this.users.updateOne(
          {
            id: ownerUserId,
            $or: [
              { deletionFenceExpiresAt: { $exists: false } },
              { deletionFenceExpiresAt: { $lte: new Date() } },
            ],
          },
          { $inc: { accountDeletionCancellationVersion: 1 } },
          { session },
        );
        if (user.matchedCount !== 1) return;
        await this.householdModel
          .updateOne(
            {
              pk: householdKey(householdId),
              ownerUserId,
              deleting: token,
            },
            { $unset: { deleting: '' } },
            { session },
          )
          .exec();
      });
    } finally {
      await session.endSession();
    }
  }

  async deleteHouseholdCascade(householdId: string): Promise<void> {
    // Keep a closed tombstone until the sweep succeeds, so a retry can resume.
    await this.householdModel
      .updateOne(
        { pk: householdKey(householdId) },
        { $set: { deleting: randomUUID() } },
      )
      .exec();
    await this.householdModel.deleteMany({ householdId }).exec();
    await this.householdModel
      .deleteOne({ pk: householdKey(householdId) })
      .exec();
  }

  private async writeOpenHouseholdChild<T>(
    householdId: string,
    userIds: Array<string | undefined>,
    write: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.householdModel.db.startSession();
    try {
      return await session.withTransaction(async () => {
        await this.assertActiveUsers(userIds, session);
        const parent = await this.householdModel
          .updateOne(
            { pk: householdKey(householdId), deleting: { $exists: false } },
            { $inc: { mutationVersion: 1 } },
            { session },
          )
          .exec();
        if (parent.matchedCount !== 1)
          throw new ConflictException(
            'Household is closing or no longer exists',
          );
        return write(session);
      });
    } finally {
      await session.endSession();
    }
  }

  private async assertMemberSpace(
    householdId: string,
    memberLimit: number,
    session: ClientSession,
    existingUserId?: string,
  ): Promise<void> {
    const filter = { entityType: 'HOUSEHOLD_MEMBERSHIP', householdId };
    const count = await this.householdModel
      .countDocuments(filter)
      .limit(memberLimit)
      .session(session)
      .exec();
    if (count < memberLimit) return;
    if (
      existingUserId &&
      (await this.householdModel
        .exists({ ...filter, userId: existingUserId })
        .session(session)
        .exec())
    )
      return;
    throw new HouseholdMemberLimitError();
  }

  private async assertActiveUsers(
    userIds: Array<string | undefined>,
    session: ClientSession,
  ): Promise<void> {
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    const now = new Date();
    const result = await this.users.bulkWrite(
      ids.map((id) => ({
        updateOne: {
          filter: {
            id,
            status: 'active',
            $or: [
              { deletionFenceExpiresAt: { $exists: false } },
              { deletionFenceExpiresAt: { $lte: now } },
            ],
          },
          update: { $inc: { householdMutationVersion: 1 } },
        },
      })),
      { ordered: true, session },
    );
    if (result.matchedCount !== ids.length)
      throw new ConflictException('User account is closing or inactive');
  }

  private get users() {
    return this.householdModel.db.collection<ActiveUserRecord>('users');
  }

  private get deletionJobs() {
    return this.householdModel.db.collection<{ _id: string }>(
      'account_deletion_jobs',
    );
  }

  private accountDeletionChange(
    record: Record<string, unknown>,
    userId: string,
    email: string,
  ): AnyBulkWriteOperation<HouseholdDocument> {
    if (typeof record.pk !== 'string')
      throw new Error('Invalid household record key');
    if (
      record.entityType === 'HOUSEHOLD_MEMBERSHIP' ||
      record.entityType === 'HOUSEHOLD_SWITCH_STATE'
    ) {
      return {
        deleteOne: {
          filter: { pk: record.pk, userId },
        },
      };
    }
    if (record.entityType === 'HOUSEHOLD_ACTIVITY') {
      const targetMatches = record.targetUserId === userId;
      return {
        updateOne: {
          filter: {
            pk: record.pk,
            $or: [{ actorUserId: userId }, { targetUserId: userId }],
          },
          update: {
            $set: {
              ...(record.actorUserId === userId
                ? { actorUserId: ANONYMIZED_USER_ID }
                : {}),
              ...(targetMatches
                ? {
                    targetUserId: ANONYMIZED_USER_ID,
                    targetLabel: ANONYMIZED_LABEL,
                  }
                : {}),
            },
          },
        },
      };
    }
    if (record.entityType === 'HOUSEHOLD_INVITE') {
      return {
        updateOne: {
          filter: {
            pk: record.pk,
            $or: [
              { invitedByUserId: userId },
              { invitedEmail: email },
              { acceptedByUserId: userId },
            ],
          },
          update: {
            $set: {
              invitedEmail: ANONYMIZED_EMAIL,
              revokedAt: new Date(),
              updatedAt: new Date(),
              privacyRedacted: true,
              ...(record.invitedByUserId === userId
                ? { invitedByUserId: ANONYMIZED_USER_ID }
                : {}),
            },
            $unset: { acceptedByUserId: '', acceptedFromHouseholdId: '' },
          },
        },
      };
    }
    throw new Error('Unsupported household privacy record');
  }

  private toHouseholdRecord(household: Household): HouseholdRecord {
    const primitives = household.toPrimitives();

    return {
      pk: householdKey(primitives.id),
      entityType: 'HOUSEHOLD',
      ...primitives,
    };
  }

  private toMembershipRecord(
    membership: HouseholdMembership,
  ): MembershipRecord {
    const primitives = membership.toPrimitives();

    return {
      pk: membershipKey(primitives.householdId, primitives.userId),
      entityType: 'HOUSEHOLD_MEMBERSHIP',
      ...primitives,
      createdAt: primitives.joinedAt,
    };
  }

  private toInviteRecord(invite: HouseholdInvite): InviteRecord {
    const primitives = invite.toPrimitives();

    return {
      pk: inviteKey(primitives.id),
      entityType: 'HOUSEHOLD_INVITE',
      ...primitives,
    };
  }

  private toActivityRecord(activity: HouseholdActivity): ActivityRecord {
    const primitives = activity.toPrimitives();

    return {
      pk: activityKey(primitives.id),
      entityType: 'HOUSEHOLD_ACTIVITY',
      ...primitives,
      updatedAt: primitives.createdAt,
    };
  }

  private toHousehold(record: HouseholdRecord): Household {
    return Household.fromPrimitives({
      id: record.id,
      name: record.name,
      ownerUserId: record.ownerUserId,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
  }

  private toMembership(record: MembershipRecord): HouseholdMembership {
    return HouseholdMembership.fromPrimitives({
      householdId: record.householdId,
      userId: record.userId,
      email: record.email,
      username: record.username,
      role: record.role,
      joinedAt: new Date(record.joinedAt),
      updatedAt: new Date(record.updatedAt),
      contextVersion: record.contextVersion,
    });
  }

  private toInvite(record: InviteRecord): HouseholdInvite {
    return HouseholdInvite.fromPrimitives({
      id: record.id,
      householdId: record.householdId,
      invitedEmail: record.invitedEmail,
      invitedByUserId: record.invitedByUserId,
      role: record.role,
      tokenHash: record.tokenHash,
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt),
      acceptedAt: record.acceptedAt ? new Date(record.acceptedAt) : undefined,
      acceptedByUserId: record.acceptedByUserId,
      acceptedFromHouseholdId: record.acceptedFromHouseholdId,
      revokedAt: record.revokedAt ? new Date(record.revokedAt) : undefined,
      updatedAt: new Date(record.updatedAt),
    });
  }

  private toActivity(record: ActivityRecord): HouseholdActivity {
    return HouseholdActivity.fromPrimitives({
      id: record.id,
      householdId: record.householdId,
      type: record.type,
      actorUserId: record.actorUserId,
      targetUserId: record.targetUserId,
      targetLabel: record.targetLabel,
      role: record.role,
      createdAt: new Date(record.createdAt),
    });
  }
}

function householdKey(id: string): string {
  return `HOUSEHOLD#${id}`;
}

function membershipKey(householdId: string, userId: string): string {
  return `HOUSEHOLD#${householdId}#MEMBER#${userId}`;
}

function switchStateKey(userId: string): string {
  return `HOUSEHOLD_SWITCH_STATE#${userId}`;
}

function inviteKey(id: string): string {
  return `HOUSEHOLD_INVITE#${id}`;
}

function activityKey(id: string): string {
  return `HOUSEHOLD_ACTIVITY#${id}`;
}
