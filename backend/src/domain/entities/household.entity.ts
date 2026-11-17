import { randomUUID } from 'crypto';
import { User } from './user.entity';
import { UserId } from '../value-objects/user-id.vo';

export const HOUSEHOLD_ROLES = ['owner', 'editor', 'viewer'] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];
export const HOUSEHOLD_ACTIVITY_TYPES = [
  'household_created',
  'invite_created',
  'invite_accepted',
  'invite_revoked',
  'member_removed',
  'shopping_share_created',
  'shopping_share_revoked',
  'shopping_list_saved',
  'shopping_list_deleted',
] as const;
export type HouseholdActivityType = (typeof HOUSEHOLD_ACTIVITY_TYPES)[number];

export interface HouseholdPrimitives {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HouseholdMembershipPrimitives {
  householdId: string;
  userId: string;
  email: string;
  username: string;
  role: HouseholdRole;
  joinedAt: Date;
  updatedAt: Date;
  contextVersion?: string;
}

export interface HouseholdInvitePrimitives {
  id: string;
  householdId: string;
  invitedEmail: string;
  invitedByUserId: string;
  role: HouseholdRole;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedByUserId?: string;
  acceptedFromHouseholdId?: string;
  revokedAt?: Date;
  updatedAt: Date;
}

export interface HouseholdActivityPrimitives {
  id: string;
  householdId: string;
  type: HouseholdActivityType;
  actorUserId: string;
  targetUserId?: string;
  targetLabel?: string;
  role?: HouseholdRole;
  createdAt: Date;
}

export class Household {
  private constructor(
    private readonly _id: string,
    private readonly _name: string,
    private readonly _ownerUserId: UserId,
    private readonly _createdAt: Date,
    private readonly _updatedAt: Date,
  ) {}

  static create(owner: User, now = new Date()): Household {
    return new Household(
      randomUUID(),
      `Hogar de ${owner.username}`,
      owner.id,
      now,
      now,
    );
  }

  static fromPrimitives(primitives: HouseholdPrimitives): Household {
    return new Household(
      normalizeId(primitives.id, 'Household id'),
      normalizeName(primitives.name),
      UserId.fromString(primitives.ownerUserId),
      new Date(primitives.createdAt),
      new Date(primitives.updatedAt),
    );
  }

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this._name;
  }

  get ownerUserId(): string {
    return this._ownerUserId.toString();
  }

  createOwnerMembership(owner: User, now = new Date()): HouseholdMembership {
    return HouseholdMembership.create({
      householdId: this._id,
      user: owner,
      role: 'owner',
      now,
    });
  }

  toPrimitives(): HouseholdPrimitives {
    return {
      id: this._id,
      name: this._name,
      ownerUserId: this.ownerUserId,
      createdAt: new Date(this._createdAt),
      updatedAt: new Date(this._updatedAt),
    };
  }
}

export class HouseholdMembership {
  private constructor(
    private readonly _householdId: string,
    private readonly _userId: UserId,
    private readonly _email: string,
    private readonly _username: string,
    private readonly _role: HouseholdRole,
    private readonly _joinedAt: Date,
    private readonly _updatedAt: Date,
    readonly contextVersion?: string,
  ) {}

  static create(params: {
    householdId: string;
    user: User;
    role: HouseholdRole;
    now: Date;
  }): HouseholdMembership {
    return new HouseholdMembership(
      normalizeId(params.householdId, 'Household id'),
      params.user.id,
      normalizeEmail(params.user.email),
      normalizeUsername(params.user.username),
      normalizeRole(params.role),
      params.now,
      params.now,
      randomUUID(),
    );
  }

  static fromPrimitives(
    primitives: HouseholdMembershipPrimitives,
  ): HouseholdMembership {
    return new HouseholdMembership(
      normalizeId(primitives.householdId, 'Household id'),
      UserId.fromString(primitives.userId),
      normalizeEmail(primitives.email),
      normalizeUsername(primitives.username),
      normalizeRole(primitives.role),
      new Date(primitives.joinedAt),
      new Date(primitives.updatedAt),
      primitives.contextVersion,
    );
  }

  get householdId(): string {
    return this._householdId;
  }

  get userId(): string {
    return this._userId.toString();
  }

  get role(): HouseholdRole {
    return this._role;
  }

  toPrimitives(): HouseholdMembershipPrimitives {
    return {
      householdId: this._householdId,
      userId: this.userId,
      email: this._email,
      username: this._username,
      role: this._role,
      joinedAt: new Date(this._joinedAt),
      updatedAt: new Date(this._updatedAt),
      contextVersion: this.contextVersion,
    };
  }
}

export class HouseholdInvite {
  private constructor(
    private readonly _id: string,
    private readonly _householdId: string,
    private readonly _invitedEmail: string,
    private readonly _invitedByUserId: UserId,
    private readonly _role: HouseholdRole,
    private readonly _tokenHash: string,
    private readonly _createdAt: Date,
    private readonly _expiresAt: Date,
    private _acceptedAt: Date | undefined,
    private _revokedAt: Date | undefined,
    private _updatedAt: Date,
    private _acceptedByUserId?: string,
    private _acceptedFromHouseholdId?: string,
  ) {}

  static create(params: {
    householdId: string;
    invitedEmail: string;
    invitedByUserId: string;
    role: Exclude<HouseholdRole, 'owner'>;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
  }): HouseholdInvite {
    return new HouseholdInvite(
      randomUUID(),
      normalizeId(params.householdId, 'Household id'),
      normalizeEmail(params.invitedEmail),
      UserId.fromString(params.invitedByUserId),
      normalizeInviteRole(params.role),
      normalizeTokenHash(params.tokenHash),
      params.createdAt,
      params.expiresAt,
      undefined,
      undefined,
      params.createdAt,
    );
  }

  static fromPrimitives(
    primitives: HouseholdInvitePrimitives,
  ): HouseholdInvite {
    return new HouseholdInvite(
      normalizeId(primitives.id, 'Household invite id'),
      normalizeId(primitives.householdId, 'Household id'),
      normalizeEmail(primitives.invitedEmail),
      UserId.fromString(primitives.invitedByUserId),
      normalizeRole(primitives.role),
      normalizeTokenHash(primitives.tokenHash),
      new Date(primitives.createdAt),
      new Date(primitives.expiresAt),
      primitives.acceptedAt ? new Date(primitives.acceptedAt) : undefined,
      primitives.revokedAt ? new Date(primitives.revokedAt) : undefined,
      new Date(primitives.updatedAt),
      primitives.acceptedByUserId,
      primitives.acceptedFromHouseholdId,
    );
  }

  get id(): string {
    return this._id;
  }

  get householdId(): string {
    return this._householdId;
  }

  get invitedEmail(): string {
    return this._invitedEmail;
  }

  get role(): HouseholdRole {
    return this._role;
  }

  isActive(now = new Date()): boolean {
    return (
      !this._acceptedAt &&
      !this._revokedAt &&
      this._expiresAt.getTime() > now.getTime()
    );
  }

  accept(
    now = new Date(),
    context?: { userId: string; fromHouseholdId?: string },
  ): void {
    if (!this.isActive(now)) {
      throw new Error('Household invite must be active before accepting');
    }

    this._acceptedAt = now;
    this._acceptedByUserId = context?.userId;
    this._acceptedFromHouseholdId = context?.fromHouseholdId;
    this._updatedAt = now;
  }

  revoke(now = new Date()): void {
    if (this._acceptedAt || this._revokedAt) {
      return;
    }

    this._revokedAt = now;
    this._updatedAt = now;
  }

  toPrimitives(): HouseholdInvitePrimitives {
    return {
      id: this._id,
      householdId: this._householdId,
      invitedEmail: this._invitedEmail,
      invitedByUserId: this._invitedByUserId.toString(),
      role: this._role,
      tokenHash: this._tokenHash,
      createdAt: new Date(this._createdAt),
      expiresAt: new Date(this._expiresAt),
      acceptedAt: this._acceptedAt ? new Date(this._acceptedAt) : undefined,
      acceptedByUserId: this._acceptedByUserId,
      acceptedFromHouseholdId: this._acceptedFromHouseholdId,
      revokedAt: this._revokedAt ? new Date(this._revokedAt) : undefined,
      updatedAt: new Date(this._updatedAt),
    };
  }
}

export class HouseholdActivity {
  private constructor(
    private readonly _id: string,
    private readonly _householdId: string,
    private readonly _type: HouseholdActivityType,
    private readonly _actorUserId: UserId,
    private readonly _targetUserId: UserId | undefined,
    private readonly _targetLabel: string | undefined,
    private readonly _role: HouseholdRole | undefined,
    private readonly _createdAt: Date,
  ) {}

  static create(params: {
    householdId: string;
    type: HouseholdActivityType;
    actorUserId: string;
    targetUserId?: string;
    targetLabel?: string;
    role?: HouseholdRole;
    createdAt?: Date;
  }): HouseholdActivity {
    const createdAt = params.createdAt ?? new Date();

    return new HouseholdActivity(
      randomUUID(),
      normalizeId(params.householdId, 'Household id'),
      normalizeActivityType(params.type),
      UserId.fromString(params.actorUserId),
      params.targetUserId ? UserId.fromString(params.targetUserId) : undefined,
      params.targetLabel
        ? normalizeOptionalLabel(params.targetLabel)
        : undefined,
      params.role ? normalizeRole(params.role) : undefined,
      createdAt,
    );
  }

  static fromPrimitives(
    primitives: HouseholdActivityPrimitives,
  ): HouseholdActivity {
    return new HouseholdActivity(
      normalizeId(primitives.id, 'Household activity id'),
      normalizeId(primitives.householdId, 'Household id'),
      normalizeActivityType(primitives.type),
      UserId.fromString(primitives.actorUserId),
      primitives.targetUserId
        ? UserId.fromString(primitives.targetUserId)
        : undefined,
      primitives.targetLabel
        ? normalizeOptionalLabel(primitives.targetLabel)
        : undefined,
      primitives.role ? normalizeRole(primitives.role) : undefined,
      new Date(primitives.createdAt),
    );
  }

  get id(): string {
    return this._id;
  }

  get householdId(): string {
    return this._householdId;
  }

  toPrimitives(): HouseholdActivityPrimitives {
    return {
      id: this._id,
      householdId: this._householdId,
      type: this._type,
      actorUserId: this._actorUserId.toString(),
      targetUserId: this._targetUserId?.toString(),
      targetLabel: this._targetLabel,
      role: this._role,
      createdAt: new Date(this._createdAt),
    };
  }
}

export function normalizeRole(role: string): HouseholdRole {
  if (HOUSEHOLD_ROLES.includes(role as HouseholdRole)) {
    return role as HouseholdRole;
  }

  throw new Error('Household role must be owner, editor, or viewer');
}

function normalizeActivityType(type: string): HouseholdActivityType {
  if (HOUSEHOLD_ACTIVITY_TYPES.includes(type as HouseholdActivityType)) {
    return type as HouseholdActivityType;
  }

  throw new Error('Household activity type is not supported');
}

function normalizeInviteRole(role: string): Exclude<HouseholdRole, 'owner'> {
  const normalizedRole = normalizeRole(role);

  if (normalizedRole === 'owner') {
    throw new Error('Household invite role must be editor or viewer');
  }

  return normalizedRole;
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${label} cannot be empty`);
  }

  return normalized;
}

function normalizeName(name: string): string {
  const normalized = name.trim();

  if (!normalized) {
    throw new Error('Household name cannot be empty');
  }

  return normalized;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLocaleLowerCase('en-US');

  if (!normalized) {
    throw new Error('Household member email cannot be empty');
  }

  return normalized;
}

function normalizeUsername(username: string): string {
  const normalized = username.trim();

  if (!normalized) {
    throw new Error('Household member username cannot be empty');
  }

  return normalized;
}

function normalizeOptionalLabel(label: string): string {
  const normalized = label.trim();

  if (!normalized) {
    throw new Error('Household activity label cannot be empty');
  }

  return normalized.slice(0, 80);
}

function normalizeTokenHash(tokenHash: string): string {
  const normalized = tokenHash.trim();

  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Household invite token hash must match sha256 hex format');
  }

  return normalized;
}
