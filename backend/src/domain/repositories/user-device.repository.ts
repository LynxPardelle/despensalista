import { UserDevice } from '../entities/user-device.entity';
import { UserId } from '../value-objects/user-id.vo';

export interface UserDeviceRepository {
  save(device: UserDevice): Promise<UserDevice | null>;
  findById(id: string): Promise<UserDevice | null>;
  findByUserId(userId: UserId, limit?: number): Promise<UserDevice[]>;
  deleteByUserId(userId: UserId): Promise<number>;
}
