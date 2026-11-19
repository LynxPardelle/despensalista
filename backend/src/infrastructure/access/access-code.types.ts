export type AccessPlan = 'plus' | 'pro';
export type AccessMode = 'plan' | 'developer';

export interface AccessCodeRecord {
  id: string;
  plan: AccessPlan;
  mode: AccessMode;
  months?: number;
  lifetime: boolean;
  redeemUntil: string;
  recipientEmail?: string;
  createdAt: string;
  issuedBy?: string;
  reason: string;
  state: 'issued' | 'redeemed' | 'revoked';
  secretHash: string;
  redeemedAt?: string;
  redeemedByHash?: string;
  redeemedHouseholdId?: string;
  revokedAt?: string;
  revokedReason?: string;
}

export type AccessCodeMetadata = Omit<
  AccessCodeRecord,
  'secretHash' | 'redeemedByHash'
>;

export interface AccessGrant {
  id: string;
  plan: AccessPlan;
  mode: AccessMode;
  lifetime: boolean;
  startsAt: string;
  expiresAt: string | null;
}

export interface AccessGrantsSnapshot {
  householdId: string;
  revision: number;
  grants: AccessGrant[];
}

export interface AccessCodeRedemption {
  code: AccessCodeRecord;
  grant: AccessGrant;
  expectedRevision: number;
  userId: string;
  householdId: string;
  joinedAt: string;
  contextVersion?: string;
  billingTable?: string;
  billingRevision?: number;
  redeemedByHash: string;
}

export interface AccessCodePage {
  items: AccessCodeMetadata[];
  cursor?: string;
}

export function activeAccessGrants(
  snapshot: AccessGrantsSnapshot,
  now = new Date(),
): AccessGrant[] {
  const instant = now.getTime();
  return snapshot.grants.filter(
    (grant) =>
      Date.parse(grant.startsAt) <= instant &&
      (grant.lifetime
        ? grant.expiresAt === null
        : grant.expiresAt !== null && Date.parse(grant.expiresAt) > instant),
  );
}

export function publicAccessCodeMetadata(
  code: AccessCodeRecord,
): AccessCodeMetadata {
  return {
    id: code.id,
    plan: code.plan,
    mode: code.mode,
    months: code.months,
    lifetime: code.lifetime,
    redeemUntil: code.redeemUntil,
    recipientEmail: code.recipientEmail,
    createdAt: code.createdAt,
    issuedBy: code.issuedBy,
    reason: code.reason,
    state: code.state,
    redeemedAt: code.redeemedAt,
    redeemedHouseholdId: code.redeemedHouseholdId,
    revokedAt: code.revokedAt,
    revokedReason: code.revokedReason,
  };
}
