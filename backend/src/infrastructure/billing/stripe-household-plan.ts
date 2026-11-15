import { Injectable } from '@nestjs/common';
import {
  FREE_HOUSEHOLD_PLAN,
  type HouseholdPlan,
  type HouseholdPlanReader,
} from '../../application/ports/household-plan-reader';
import { StripeBillingConfig } from './stripe-billing-config';
import { StripeBillingStore, type BillingRecord } from './stripe-billing.store';

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
  ) {}

  async getPlan(householdId: string): Promise<HouseholdPlan> {
    const table = this.config.getBillingTable();
    const record = table
      ? await this.store.read(table, householdId)
      : undefined;
    const paidThrough = paidPlusThrough(record);
    if (paidThrough === undefined) return { ...FREE_HOUSEHOLD_PLAN };
    return {
      tier: 'plus',
      memberLimit: 5,
      savedListLimit: 15,
      paidThrough: new Date(paidThrough * 1000).toISOString(),
    };
  }
}
