export interface UserPreferences {
  expirationWarningDays: number;
  showExpiredEntryAlert: boolean;
  depletionWarningThresholdRatio: number;
  shoppingPlanLeadDays: number;
  showGuidanceTips: boolean;
}

export type UserPreferencesUpdate = Partial<UserPreferences>;

export interface DeletePantryDataRequest {
  confirmationText: string;
}

export interface DeletePantryDataResult {
  deletedInventoryLotCount: number;
  deletedProductTypeCount: number;
  deletedShoppingListCount: number;
  deletedShoppingShareCount: number;
  deletedWasteEventCount: number;
}

export interface DeleteAccountRequest {
  confirmationText: string;
}

export interface DeleteAccountResult {
  deletedInventoryLotCount: number;
  deletedProductTypeCount: number;
  deletedShoppingListCount: number;
  deletedShoppingShareCount: number;
  deletedWasteEventCount: number;
  deletedKnownDeviceCount: number;
  deletedCognitoIdentityCount: number;
}

export interface SignOutAllSessionsRequest {
  confirmationText: string;
}

export interface SignOutAllSessionsResult {
  revokedCognitoSessionCount: number;
  localSessionCleared: boolean;
}

export interface RetentionPolicy {
  archivedRecordRetentionDays: number;
  archivedRecordAutoDeleteEnabled: boolean;
  temporaryShoppingShareRetentionDays: number;
  permanentlyDeletedRecords: 'removed_immediately';
  accountDeletion: 'local_and_cognito_delete_requested';
}

export interface ApiStepUpSecurity {
  enabled: boolean;
  maxAgeSeconds: number;
  fresh: boolean;
  authenticatedAt?: string;
  freshUntil?: string;
}

export interface StepUpSecurity {
  enabled: boolean;
  maxAgeSeconds: number;
  fresh: boolean;
  authenticatedAt?: Date;
  freshUntil?: Date;
}

export interface ApiProfileSecurity {
  stepUp: ApiStepUpSecurity;
}

export interface ProfileSecurity {
  stepUp: StepUpSecurity;
}

export interface ApiKnownUserDevice {
  id: string;
  label: string;
  userAgentSummary: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  current: boolean;
}

export interface KnownUserDevice {
  id: string;
  label: string;
  userAgentSummary: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seenCount: number;
  current: boolean;
}

export type HouseholdRole = 'owner' | 'editor' | 'viewer';
export type HouseholdActivityType =
  | 'household_created'
  | 'invite_created'
  | 'invite_accepted'
  | 'invite_revoked'
  | 'member_removed'
  | 'shopping_share_created'
  | 'shopping_share_revoked'
  | 'shopping_list_saved'
  | 'shopping_list_deleted';

export interface ApiHousehold {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Household {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiHouseholdMember {
  householdId: string;
  userId: string;
  email: string;
  username: string;
  role: HouseholdRole;
  joinedAt: string;
  updatedAt: string;
}

export interface HouseholdMember {
  householdId: string;
  userId: string;
  email: string;
  username: string;
  role: HouseholdRole;
  joinedAt: Date;
  updatedAt: Date;
}

export interface ApiHouseholdInvite {
  id: string;
  householdId: string;
  invitedEmail: string;
  invitedByUserId: string;
  role: HouseholdRole;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  updatedAt: string;
}

export interface HouseholdInvite {
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

export interface ApiHouseholdActivity {
  id: string;
  householdId: string;
  type: HouseholdActivityType;
  actorUserId: string;
  targetUserId?: string;
  targetLabel?: string;
  role?: HouseholdRole;
  createdAt: string;
}

export interface HouseholdActivity {
  id: string;
  householdId: string;
  type: HouseholdActivityType;
  actorUserId: string;
  targetUserId?: string;
  targetLabel?: string;
  role?: HouseholdRole;
  createdAt: Date;
}

export interface HouseholdPlan {
  tier: 'free' | 'plus';
  memberLimit: number;
  savedListLimit: number;
  paidThrough: string | null;
}

export interface ApiHouseholdWorkspace {
  household: ApiHousehold;
  plan?: HouseholdPlan;
  currentMember: ApiHouseholdMember;
  members: ApiHouseholdMember[];
  invites: ApiHouseholdInvite[];
  activities: ApiHouseholdActivity[];
}

export interface HouseholdWorkspace {
  household: Household;
  plan?: HouseholdPlan;
  currentMember: HouseholdMember;
  members: HouseholdMember[];
  invites: HouseholdInvite[];
  activities: HouseholdActivity[];
}

export interface CreateHouseholdInviteRequest {
  email: string;
  role: Exclude<HouseholdRole, 'owner'>;
}

export interface CreateHouseholdInviteResult {
  invite: HouseholdInvite;
  token: string;
}

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  status: 'active' | 'disabled';
  connectedIdentityCount: number;
  createdAt: Date;
  updatedAt: Date;
  preferences: UserPreferences;
  retentionPolicy: RetentionPolicy;
  security: ProfileSecurity;
  knownDevices: KnownUserDevice[];
}

export interface ApiUserProfile {
  id: string;
  email: string;
  username: string;
  status: 'active' | 'disabled';
  connectedIdentityCount: number;
  createdAt: string;
  updatedAt: string;
  preferences: UserPreferences;
  retentionPolicy: RetentionPolicy;
  security: ApiProfileSecurity;
  knownDevices?: ApiKnownUserDevice[];
}
