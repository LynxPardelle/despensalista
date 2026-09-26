import {
  Household,
  HouseholdActivity,
  HouseholdInvite,
  HouseholdMembership,
} from '../entities/household.entity';

export interface HouseholdDeletionLock {
  canDelete: boolean;
  token?: string;
}

export interface HouseholdRepository {
  createHouseholdWithOwner(
    household: Household,
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership>;
  acceptInvite(
    invite: HouseholdInvite,
    membership: HouseholdMembership,
  ): Promise<HouseholdMembership>;
  saveHousehold(household: Household): Promise<Household>;
  saveMembership(membership: HouseholdMembership): Promise<HouseholdMembership>;
  saveInvite(invite: HouseholdInvite): Promise<HouseholdInvite>;
  saveActivity(activity: HouseholdActivity): Promise<HouseholdActivity>;
  findHouseholdById(id: string): Promise<Household | null>;
  findMembershipByUserId(userId: string): Promise<HouseholdMembership | null>;
  findMembershipByHouseholdAndUserId(
    householdId: string,
    userId: string,
  ): Promise<HouseholdMembership | null>;
  findMembersByHouseholdId(householdId: string): Promise<HouseholdMembership[]>;
  deleteMembership(householdId: string, userId: string): Promise<void>;
  findActiveInvitesByHouseholdId(
    householdId: string,
    now: Date,
  ): Promise<HouseholdInvite[]>;
  findInviteById(id: string): Promise<HouseholdInvite | null>;
  findInviteByTokenHash(tokenHash: string): Promise<HouseholdInvite | null>;
  findActivitiesByHouseholdId(
    householdId: string,
    limit: number,
  ): Promise<HouseholdActivity[]>;
  deleteAccountHouseholdData(
    householdId: string,
    userId: string,
    email: string,
  ): Promise<void>;
  // Locks new household writes before deletion. False leaves the household open
  // when other members still exist; a successful lock can be retried after failure.
  beginHouseholdDeletion(
    householdId: string,
    ownerUserId: string,
  ): Promise<HouseholdDeletionLock>;
  cancelHouseholdDeletion(
    householdId: string,
    ownerUserId: string,
    token: string,
  ): Promise<void>;
  deleteHouseholdCascade(householdId: string): Promise<void>;
}
