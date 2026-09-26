import { User } from '../../../domain/entities/user.entity';
import { UserId } from '../../../domain/value-objects/user-id.vo';

export interface UserDao {
  save(user: User): Promise<User>;
  findById(id: UserId): Promise<User | null>;
  findByAuthSubject(authSubjectId: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  beginAccountDeletion(id: UserId, expiresAt: Date): Promise<User | null>;
  delete(id: UserId): Promise<void>;
}
