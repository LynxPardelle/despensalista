export const MONTHLY_PURCHASE_SPEND_READER = Symbol(
  'MONTHLY_PURCHASE_SPEND_READER',
);

export interface MonthlyPurchaseSpend {
  month: string;
  amountMinor: number;
  pricedItemCount: number;
  unpricedItemCount: number;
}

export interface MonthlyPurchaseSpendReader {
  getMonthlyPurchaseSpend(
    ownerUserId: string,
    month: string,
  ): Promise<MonthlyPurchaseSpend>;
}

export function purchaseSpendFields(month: string) {
  return {
    amountMinor: `purchaseAmount_${month}`,
    pricedItemCount: `purchasePriced_${month}`,
    unpricedItemCount: `purchaseUnpriced_${month}`,
  } as const;
}

export function purchaseSpendIncrements(
  spend: MonthlyPurchaseSpend,
): Record<string, number> {
  const fields = purchaseSpendFields(spend.month);
  return {
    [fields.amountMinor]: spend.amountMinor,
    [fields.pricedItemCount]: spend.pricedItemCount,
    [fields.unpricedItemCount]: spend.unpricedItemCount,
  };
}

export function retainedPurchaseSpendFields(
  quota: Record<string, unknown>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(quota).filter(
      (entry): entry is [string, number] =>
        /^purchase(?:Amount|Priced|Unpriced)_\d{4}-\d{2}$/.test(entry[0]) &&
        typeof entry[1] === 'number',
    ),
  );
}

export function readMonthlyPurchaseSpend(
  row: Record<string, unknown> | undefined | null,
  month: string,
): MonthlyPurchaseSpend {
  const fields = purchaseSpendFields(month);
  const numberAt = (key: string): number => {
    const value = row?.[key];
    return typeof value === 'number' ? value : 0;
  };
  return {
    month,
    amountMinor: numberAt(fields.amountMinor),
    pricedItemCount: numberAt(fields.pricedItemCount),
    unpricedItemCount: numberAt(fields.unpricedItemCount),
  };
}
