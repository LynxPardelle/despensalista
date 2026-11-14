export interface HouseholdBilling {
  stopRenewals(householdId: string): Promise<void>;
}
