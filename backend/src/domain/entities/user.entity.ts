import { UserAccountStatus } from '../enums';
import { UserId } from '../value-objects/user-id.vo';

export interface UserPrimitives {
  id: string;
  email: string;
  username: string;
  authSubjectIds?: string[];
  status: UserAccountStatus;
  createdAt: Date;
  updatedAt: Date;
  deletionFenceExpiresAt?: Date;
}

export class User {
  private constructor(
    private readonly _id: UserId,
    private _email: string,
    private _username: string,
    private _authSubjectIds: string[],
    private _status: UserAccountStatus,
    private readonly _createdAt: Date = new Date(),
    private _updatedAt: Date = new Date(),
    private readonly _deletionFenceExpiresAt?: Date,
  ) {}

  static create(email: string, username: string): User {
    const id = UserId.generate();
    return new User(
      id,
      normalizeEmail(email),
      normalizeUsername(username),
      [],
      UserAccountStatus.ACTIVE,
    );
  }

  static fromPrimitives(primitives: UserPrimitives): User {
    return new User(
      UserId.fromString(primitives.id),
      primitives.email,
      primitives.username,
      normalizeAuthSubjectIds(primitives.authSubjectIds ?? []),
      primitives.status,
      primitives.createdAt,
      primitives.updatedAt,
      primitives.deletionFenceExpiresAt,
    );
  }

  get id(): UserId {
    return this._id;
  }

  get email(): string {
    return this._email;
  }

  get username(): string {
    return this._username;
  }

  get status(): UserAccountStatus {
    return this._status;
  }

  get authSubjectIds(): string[] {
    return [...this._authSubjectIds];
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  isAccountDeletionPending(now = new Date()): boolean {
    return Boolean(
      this._deletionFenceExpiresAt && this._deletionFenceExpiresAt > now,
    );
  }

  updateUsername(newUsername: string): void {
    this._username = normalizeUsername(newUsername);
    this._updatedAt = new Date();
  }

  updateEmail(newEmail: string): void {
    this._email = normalizeEmail(newEmail);
    this._updatedAt = new Date();
  }

  hasAuthSubject(authSubjectId: string): boolean {
    return this._authSubjectIds.includes(normalizeAuthSubjectId(authSubjectId));
  }

  linkAuthSubject(authSubjectId: string): void {
    const normalizedAuthSubjectId = normalizeAuthSubjectId(authSubjectId);

    if (this._authSubjectIds.includes(normalizedAuthSubjectId)) {
      return;
    }

    this._authSubjectIds = [...this._authSubjectIds, normalizedAuthSubjectId];
    this._updatedAt = new Date();
  }

  disable(): void {
    this._status = UserAccountStatus.DISABLED;
    this._updatedAt = new Date();
  }

  activate(): void {
    this._status = UserAccountStatus.ACTIVE;
    this._updatedAt = new Date();
  }

  toPrimitives(): UserPrimitives {
    return {
      id: this._id.toString(),
      email: this._email,
      username: this._username,
      authSubjectIds: this.authSubjectIds,
      status: this._status,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      ...(this._deletionFenceExpiresAt
        ? { deletionFenceExpiresAt: this._deletionFenceExpiresAt }
        : {}),
    };
  }
}

function normalizeEmail(email: string): string {
  const normalizedEmail = email.trim().toLocaleLowerCase('en-US');

  if (!normalizedEmail) {
    throw new Error('Email cannot be empty');
  }

  return normalizedEmail;
}

function normalizeUsername(username: string): string {
  const normalizedUsername = username.trim();

  if (!normalizedUsername) {
    throw new Error('Username cannot be empty');
  }

  return normalizedUsername;
}

function normalizeAuthSubjectId(authSubjectId: string): string {
  const normalizedAuthSubjectId = authSubjectId.trim();

  if (!normalizedAuthSubjectId) {
    throw new Error('Auth subject id cannot be empty');
  }

  return normalizedAuthSubjectId;
}

function normalizeAuthSubjectIds(authSubjectIds: string[]): string[] {
  return [...new Set(authSubjectIds.map(normalizeAuthSubjectId))];
}
