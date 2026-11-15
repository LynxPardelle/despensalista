export const HOUSEHOLD_PLAN_READER = Symbol('HOUSEHOLD_PLAN_READER');

export interface HouseholdPlan {
  tier: 'free' | 'plus';
  memberLimit: number;
  savedListLimit: number;
  paidThrough: string | null;
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
