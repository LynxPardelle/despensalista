import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ShoppingShare,
  ShoppingSharePrimitives,
} from '../../../domain/entities/shopping-share.entity';
import { ShoppingShareRepository } from '../../../domain/repositories/shopping-share.repository';
import { UserId } from '../../../domain/value-objects/user-id.vo';
import { ShoppingShareDocument } from './schemas/shopping-share.schema';

@Injectable()
export class MongoShoppingShareRepository implements ShoppingShareRepository {
  constructor(
    @InjectModel(ShoppingShareDocument.name)
    private readonly shoppingShareModel: Model<ShoppingShareDocument>,
  ) {}

  async findByTokenHash(tokenHash: string): Promise<ShoppingShare | null> {
    const share = await this.shoppingShareModel
      .findOne({ tokenHash })
      .lean()
      .exec();

    return share ? this.toDomain(share) : null;
  }

  async findById(id: string): Promise<ShoppingShare | null> {
    const share = await this.shoppingShareModel.findOne({ id }).lean().exec();

    return share ? this.toDomain(share) : null;
  }

  async listActiveByOwnerUserId(
    ownerUserId: string,
    now: Date,
  ): Promise<ShoppingShare[]> {
    const shares = await this.shoppingShareModel
      .find({
        ownerUserId,
        expiresAt: { $gt: now },
        $or: [{ revokedAt: { $exists: false } }, { revokedAt: null }],
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .lean()
      .exec();

    return shares.map((share) => this.toDomain(share));
  }

  async deleteByOwnerUserId(userId: UserId): Promise<number> {
    const result = await this.shoppingShareModel
      .deleteMany({ ownerUserId: userId.toString() })
      .exec();

    return result.deletedCount ?? 0;
  }

  private toDomain(primitives: ShoppingSharePrimitives): ShoppingShare {
    return ShoppingShare.fromPrimitives(primitives);
  }
}
