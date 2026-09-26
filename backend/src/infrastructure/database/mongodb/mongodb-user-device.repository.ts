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

@Injectable()
export class MongoUserDeviceRepository implements UserDeviceRepository {
  constructor(
    @InjectModel(UserDeviceDocument.name)
    private readonly userDeviceModel: Model<UserDeviceDocument>,
  ) {}

  async save(device: UserDevice): Promise<UserDevice> {
    const primitives = device.toPrimitives();
    const session = await this.userDeviceModel.db.startSession();
    let savedDevice: UserDevicePrimitives | null = null;
    try {
      await session.withTransaction(async () => {
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
        savedDevice = await this.userDeviceModel
          .findOneAndUpdate(
            { id: primitives.id },
            { $set: primitives },
            { new: true, upsert: true, session },
          )
          .lean()
          .exec();
      });
    } finally {
      await session.endSession();
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
    const result = await this.userDeviceModel
      .deleteMany({ userId: userId.toString() })
      .exec();

    return result.deletedCount;
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
