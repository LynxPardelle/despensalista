import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserPreferencesDao } from '../../../application/ports/daos';
import {
  UserPreferences,
  UserPreferencesPatch,
  UserPreferencesPrimitives,
} from '../../../domain/value-objects/user-preferences.vo';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { UserDocument } from './schemas/user.schema';

type UserWithPreferences = {
  preferences?: Partial<UserPreferencesPrimitives>;
};

@Injectable()
export class MongoUserPreferencesDao implements UserPreferencesDao {
  constructor(
    @InjectModel(UserDocument.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async findByUserId(userId: UserId): Promise<UserPreferences> {
    const user = await this.userModel
      .findOne({ id: userId.toString() })
      .select({ preferences: 1 })
      .lean<UserWithPreferences>()
      .exec();

    return UserPreferences.resolve(user?.preferences);
  }

  async save(
    userId: UserId,
    preferences: UserPreferences | UserPreferencesPatch,
  ): Promise<UserPreferences> {
    const resolvedPreferences =
      preferences instanceof UserPreferences
        ? preferences
        : UserPreferences.resolve(preferences);
    const now = new Date();
    const savedUser = await this.userModel
      .findOneAndUpdate(
        {
          id: userId.toString(),
          status: 'active',
          $or: [
            { deletionFenceExpiresAt: { $exists: false } },
            { deletionFenceExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            preferences: resolvedPreferences.toPrimitives(),
            updatedAt: now,
          },
        },
        { new: true },
      )
      .select({ preferences: 1 })
      .lean<UserWithPreferences>()
      .exec();

    if (!savedUser) {
      throw new UnauthorizedException('Account deletion is in progress');
    }

    return UserPreferences.resolve(savedUser.preferences);
  }
}
