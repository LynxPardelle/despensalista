export const HOUSEHOLD_PLAN_READER = Symbol('HOUSEHOLD_PLAN_READER');

export interface HouseholdPlan {
  tier: 'free' | 'plus' | 'pro';
  memberLimit: number | null;
  savedListLimit: number | null;
  paidThrough: string | null;
  source?: 'free' | 'stripe' | 'code';
  lifetime?: boolean;
  validUntil?: string | null;
  unlimitedUsage?: boolean;
  technicalSavedListLimit?: number;
}

export interface HouseholdPlanReader {
  getPlan(householdId: string): Promise<HouseholdPlan>;
}

export const FREE_HOUSEHOLD_PLAN: Readonly<HouseholdPlan> = {
  tier: 'free',
  memberLimit: 2,
  savedListLimit: 3,
  paidThrough: null,
};
