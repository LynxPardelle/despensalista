import { StripeBillingStore, type BillingRecord } from './stripe-billing.store';
import type { StripeBillingConfig } from './stripe-billing-config';
import { StripeHouseholdPlan } from './stripe-household-plan';

describe('StripeHouseholdPlan', () => {
  const paidThrough = Date.parse('2026-12-01T08:00:00Z') / 1000;
  const read = jest.fn<Promise<BillingRecord | undefined>, [string, string]>();
  const plan = new StripeHouseholdPlan(
    { getBillingTable: () => 'dev-billing' } as unknown as StripeBillingConfig,
    { read } as unknown as StripeBillingStore,
  );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-14T08:00:00Z'));
    read.mockReset();
  });

  afterEach(() => jest.useRealTimers());

  it('keeps paid limits when automatic renewal has been canceled', async () => {
    read.mockResolvedValue({
      householdId: 'home',
      revision: 1,
      status: 'active',
      paidThrough,
      cancelAtPeriodEnd: true,
    });
    await expect(plan.getPlan('home')).resolves.toEqual({
      tier: 'plus',
      memberLimit: 5,
      savedListLimit: 15,
      paidThrough: '2026-12-01T08:00:00.000Z',
    });
    expect(read).toHaveBeenCalledWith('dev-billing', 'home');
  });

  it('returns Free limits exactly at the end of the paid period', async () => {
    jest.setSystemTime(paidThrough * 1000);
    read.mockResolvedValue({
      householdId: 'home',
      revision: 1,
      status: 'active',
      paidThrough,
      cancelAtPeriodEnd: true,
    });
    await expect(plan.getPlan('home')).resolves.toEqual({
      tier: 'free',
      memberLimit: 2,
      savedListLimit: 3,
      paidThrough: null,
    });
  });

  it.each(['pending', 'past_due', 'canceled'] as const)(
    'keeps %s subscriptions on Free',
    async (status) => {
      read.mockResolvedValue({
        householdId: 'home',
        revision: 1,
        status,
        paidThrough,
      });
      await expect(plan.getPlan('home')).resolves.toMatchObject({
        tier: 'free',
      });
    },
  );

  it('keeps households without a billing record on Free', async () => {
    await expect(plan.getPlan('home')).resolves.toMatchObject({ tier: 'free' });
  });
});
