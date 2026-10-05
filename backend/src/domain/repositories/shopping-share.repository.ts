import { ShoppingShare } from '../entities/shopping-share.entity';
import { UserId } from '../value-objects/user-id.vo';

export interface ShoppingShareRepository {
  findById(id: string): Promise<ShoppingShare | null>;
  findByTokenHash(tokenHash: string): Promise<ShoppingShare | null>;
  listActiveByOwnerUserId(
    ownerUserId: string,
    now: Date,
  ): Promise<ShoppingShare[]>;
  deleteByOwnerUserId(userId: UserId): Promise<number>;
}
