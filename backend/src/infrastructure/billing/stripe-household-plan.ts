import { Injectable, Optional } from '@nestjs/common';
import {
  FREE_HOUSEHOLD_PLAN,
  type HouseholdPlan,
  type HouseholdPlanReader,
} from '../../application/ports/household-plan-reader';
import { StripeBillingConfig } from './stripe-billing-config';
import { StripeBillingStore, type BillingRecord } from './stripe-billing.store';
import { AccessCodeStore } from '../access/access-code.store';
import {
  activeAccessGrants,
  type AccessGrant,
} from '../access/access-code.types';
import { MAX_SAVED_SHOPPING_LISTS_PER_USER } from '../../application/constants/query-limits';

export function paidPlusThrough(
  record: BillingRecord | undefined,
): number | undefined {
  if (
    !record?.closed &&
    record?.status === 'active' &&
    record.paidThrough !== undefined &&
    record.paidThrough > Math.floor(Date.now() / 1000)
  ) {
    return record.paidThrough;
  }
}

@Injectable()
export class StripeHouseholdPlan implements HouseholdPlanReader {
  constructor(
    private readonly config: StripeBillingConfig,
    private readonly store: StripeBillingStore,
    @Optional() private readonly accessCodes?: AccessCodeStore,
  ) {}

  async getPlan(householdId: string): Promise<HouseholdPlan> {
    const table = this.config.getBillingTable();
    const [record, snapshot] = await Promise.all([
      table ? this.store.read(table, householdId) : undefined,
      this.accessCodes?.readGrants(householdId),
    ]);
    const paidThrough = paidPlusThrough(record);
    const grants = snapshot ? activeAccessGrants(snapshot) : [];
    if (grants.length) return planFromAccessGrants(grants, paidThrough);
    if (paidThrough === undefined) return { ...FREE_HOUSEHOLD_PLAN };
    return {
      tier: 'plus',
      memberLimit: 5,
      savedListLimit: 15,
      paidThrough: new Date(paidThrough * 1000).toISOString(),
    };
  }
}

export function planFromAccessGrants(
  grants: AccessGrant[],
  paidThrough?: number,
): HouseholdPlan {
  const tier = grants.some((grant) => grant.plan === 'pro') ? 'pro' : 'plus';
  const selected = grants.filter((grant) => grant.plan === tier);
  const lifetime = selected.some((grant) => grant.lifetime);
  const unlimitedUsage = grants.some((grant) => grant.mode === 'developer');
  const grantEnd = Math.max(
    ...selected.map((grant) =>
      grant.expiresAt ? Date.parse(grant.expiresAt) : 0,
    ),
    tier === 'plus' && paidThrough ? paidThrough * 1000 : 0,
  );
  return {
    tier,
    memberLimit: unlimitedUsage ? null : 5,
    savedListLimit: unlimitedUsage ? null : 15,
    paidThrough: paidThrough
      ? new Date(paidThrough * 1000).toISOString()
      : null,
    source: 'code',
    lifetime,
    validUntil: lifetime ? null : new Date(grantEnd).toISOString(),
    unlimitedUsage,
    ...(unlimitedUsage && {
      technicalSavedListLimit: MAX_SAVED_SHOPPING_LISTS_PER_USER,
    }),
  };
}
