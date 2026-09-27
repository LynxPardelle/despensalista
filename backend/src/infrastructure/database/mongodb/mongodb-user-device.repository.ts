import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  UserDevice,
  UserDevicePrimitives,
} from '../../../domain/entities/user-device.entity';
import { UserDeviceRepository } from '../../../domain/repositories/user-device.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserDeviceDocument } from './schemas/user-device.schema';

type UserDeviceReservation = {
  _id: string;
  count: number;
};

const MAX_USER_DEVICES_PER_USER = 25;

@Injectable()
export class MongoUserDeviceRepository implements UserDeviceRepository {
  constructor(
    @InjectModel(UserDeviceDocument.name)
    private readonly userDeviceModel: Model<UserDeviceDocument>,
  ) {}

  async save(device: UserDevice): Promise<UserDevice | null> {
    const primitives = device.toPrimitives();
    const session = await this.userDeviceModel.db.startSession();
    let savedDevice: UserDevicePrimitives | null = null;
    let capacityReached = false;
    try {
      await session.withTransaction(async () => {
        savedDevice = null;
        capacityReached = false;
        const now = new Date();
        const account = await this.userDeviceModel.db
          .collection('users')
          .updateOne(
            {
              id: primitives.userId,
              status: 'active',
              $or: [
                { deletionFenceExpiresAt: { $exists: false } },
                { deletionFenceExpiresAt: { $lte: now } },
              ],
            },
            { $inc: { mutationVersion: 1 } },
            { session },
          );
        if (account.matchedCount !== 1) {
          throw new UnauthorizedException('Account deletion is in progress');
        }

        const existing = await this.userDeviceModel
          .findOne({ id: primitives.id, userId: primitives.userId })
          .session(session)
          .lean()
          .exec();

        if (!existing) {
          let reservation = await this.reservations.findOne(
            { _id: primitives.userId },
            { session },
          );

          if (!reservation) {
            const count = await this.userDeviceModel
              .countDocuments({ userId: primitives.userId })
              .session(session)
              .exec();
            reservation = { _id: primitives.userId, count };
            await this.reservations.insertOne(reservation, { session });
          }

          if (reservation.count >= MAX_USER_DEVICES_PER_USER) {
            capacityReached = true;
            return;
          }

          const claimed = await this.reservations.updateOne(
            {
              _id: primitives.userId,
              count: { $lt: MAX_USER_DEVICES_PER_USER },
            },
            { $inc: { count: 1 } },
            { session },
          );
          if (claimed.matchedCount !== 1) {
            capacityReached = true;
            return;
          }
        }

        savedDevice = await this.userDeviceModel
          .findOneAndUpdate(
            { id: primitives.id, userId: primitives.userId },
            { $set: primitives },
            { new: true, upsert: true, session },
          )
          .lean()
          .exec();
      });
    } finally {
      await session.endSession();
    }

    if (capacityReached) {
      return null;
    }

    if (!savedDevice) {
      throw new UnauthorizedException('Account deletion is in progress');
    }

    return this.toDomain(savedDevice);
  }

  async findById(id: string): Promise<UserDevice | null> {
    const device = await this.userDeviceModel.findOne({ id }).lean().exec();

    return device ? this.toDomain(device) : null;
  }

  async findByUserId(userId: UserId, limit = 10): Promise<UserDevice[]> {
    const devices = await this.userDeviceModel
      .find({ userId: userId.toString() })
      .sort({ lastSeenAt: -1 })
      .limit(Math.min(Math.max(1, Math.trunc(limit)), 25))
      .lean()
      .exec();

    return devices.map((device) => this.toDomain(device));
  }

  async deleteByUserId(userId: UserId): Promise<number> {
    const normalizedUserId = userId.toString();
    const session = await this.userDeviceModel.db.startSession();
    let deletedCount = 0;
    try {
      await session.withTransaction(async () => {
        const result = await this.userDeviceModel
          .deleteMany({ userId: normalizedUserId })
          .session(session)
          .exec();
        deletedCount = result.deletedCount;
        await this.reservations.deleteOne(
          { _id: normalizedUserId },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    return deletedCount;
  }

  private get reservations() {
    return this.userDeviceModel.db.collection<UserDeviceReservation>(
      'user_device_reservations',
    );
  }

  private toDomain(device: UserDevicePrimitives): UserDevice {
    return UserDevice.fromPrimitives({
      id: device.id,
      userId: device.userId,
      label: device.label,
      userAgentSummary: device.userAgentSummary,
      firstSeenAt: new Date(device.firstSeenAt),
      lastSeenAt: new Date(device.lastSeenAt),
      seenCount: device.seenCount,
    });
  }
}
