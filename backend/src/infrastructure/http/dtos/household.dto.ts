import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import {
  HouseholdActivityType,
  HouseholdRole,
} from '../../../domain/entities/household.entity';

export class CreateHouseholdInviteDto {
  @IsEmail()
  email: string;

  @IsIn(['editor', 'viewer'])
  role: Exclude<HouseholdRole, 'owner'>;
}

export class AcceptHouseholdInviteDto {
  @IsString()
  @MinLength(16)
  token: string;

  @IsOptional()
  @IsUUID('4')
  switchFromHouseholdId?: string;
}

export interface HouseholdResponseDto {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HouseholdMemberResponseDto {
  householdId: string;
  userId: string;
  email: string;
  username: string;
  role: HouseholdRole;
  joinedAt: Date;
  updatedAt: Date;
}

export interface HouseholdInviteResponseDto {
  id: string;
  householdId: string;
  invitedEmail: string;
  invitedByUserId: string;
  role: HouseholdRole;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
  revokedAt?: Date;
  updatedAt: Date;
}

export interface HouseholdActivityResponseDto {
  id: string;
  householdId: string;
  type: HouseholdActivityType;
  actorUserId: string;
  targetUserId?: string;
  targetLabel?: string;
  role?: HouseholdRole;
  createdAt: Date;
}

export interface HouseholdWorkspaceResponseDto {
  household: HouseholdResponseDto;
  plan: {
    tier: 'free' | 'plus' | 'pro';
    memberLimit: number | null;
    savedListLimit: number | null;
    paidThrough: string | null;
    source?: 'free' | 'stripe' | 'code';
    lifetime?: boolean;
    validUntil?: string | null;
    unlimitedUsage?: boolean;
    technicalSavedListLimit?: number;
  };
  currentMember: HouseholdMemberResponseDto;
  members: HouseholdMemberResponseDto[];
  invites: HouseholdInviteResponseDto[];
  activities: HouseholdActivityResponseDto[];
}

export interface CreateHouseholdInviteResponseDto {
  invite: HouseholdInviteResponseDto;
  token: string;
}
