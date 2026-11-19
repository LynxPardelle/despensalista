import { StripeBillingStore, type BillingRecord } from './stripe-billing.store';
import type { StripeBillingConfig } from './stripe-billing-config';
import { StripeHouseholdPlan } from './stripe-household-plan';
import type { AccessCodeStore } from '../access/access-code.store';
import type { AccessGrant } from '../access/access-code.types';

describe('StripeHouseholdPlan', () => {
  const paidThrough = Date.parse('2026-12-01T08:00:00Z') / 1000;
  const read = jest.fn<Promise<BillingRecord | undefined>, [string, string]>();
  const readGrants = jest.fn();
  const plan = new StripeHouseholdPlan(
    { getBillingTable: () => 'dev-billing' } as unknown as StripeBillingConfig,
    { read } as unknown as StripeBillingStore,
    { readGrants } as unknown as AccessCodeStore,
  );

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-14T08:00:00Z'));
    read.mockReset();
    readGrants
      .mockReset()
      .mockResolvedValue({ householdId: 'home', revision: 0, grants: [] });
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

  it.each(['plus', 'pro'] as const)(
    'grants %s without a Stripe subscription',
    async (tier) => {
      readGrants.mockResolvedValue({
        householdId: 'home',
        revision: 1,
        grants: [makeGrant({ plan: tier })],
      });
      await expect(plan.getPlan('home')).resolves.toMatchObject({
        tier,
        source: 'code',
        paidThrough: null,
        memberLimit: 5,
        savedListLimit: 15,
        validUntil: '2026-12-14T08:00:00.000Z',
        lifetime: false,
        unlimitedUsage: false,
      });
    },
  );

  it('selects active Pro and removes only commercial limits for a developer grant', async () => {
    readGrants.mockResolvedValue({
      householdId: 'home',
      revision: 2,
      grants: [
        makeGrant(),
        makeGrant({
          id: 'developer',
          plan: 'pro',
          mode: 'developer',
          lifetime: true,
          expiresAt: null,
        }),
      ],
    });
    await expect(plan.getPlan('home')).resolves.toMatchObject({
      tier: 'pro',
      source: 'code',
      lifetime: true,
      validUntil: null,
      memberLimit: null,
      savedListLimit: null,
      unlimitedUsage: true,
      technicalSavedListLimit: 25,
    });
  });

  it('ignores future and expired gifts and preserves a current paid subscription', async () => {
    read.mockResolvedValue({
      householdId: 'home',
      revision: 1,
      status: 'active',
      paidThrough,
    });
    readGrants.mockResolvedValue({
      householdId: 'home',
      revision: 2,
      grants: [
        makeGrant({ expiresAt: '2026-11-14T08:00:00.000Z' }),
        makeGrant({ id: 'future', startsAt: '2026-12-02T08:00:00.000Z' }),
      ],
    });
    await expect(plan.getPlan('home')).resolves.toMatchObject({
      tier: 'plus',
      paidThrough: '2026-12-01T08:00:00.000Z',
    });
  });

  it('keeps a lifetime developer grant after a temporary higher-level grant ends', async () => {
    readGrants.mockResolvedValue({
      householdId: 'home',
      revision: 2,
      grants: [
        makeGrant({
          id: 'developer',
          mode: 'developer',
          lifetime: true,
          expiresAt: null,
        }),
        makeGrant({ id: 'pro-gift', plan: 'pro' }),
      ],
    });
    await expect(plan.getPlan('home')).resolves.toMatchObject({
      tier: 'pro',
      lifetime: false,
      validUntil: '2026-12-14T08:00:00.000Z',
      unlimitedUsage: true,
      memberLimit: null,
      savedListLimit: null,
    });
    jest.setSystemTime(new Date('2026-12-14T08:00:00.000Z'));
    await expect(plan.getPlan('home')).resolves.toMatchObject({
      tier: 'plus',
      lifetime: true,
      validUntil: null,
      unlimitedUsage: true,
      memberLimit: null,
      savedListLimit: null,
    });
  });
});

function makeGrant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    id: 'gift',
    plan: 'plus',
    mode: 'plan',
    lifetime: false,
    startsAt: '2026-11-14T00:00:00.000Z',
    expiresAt: '2026-12-14T08:00:00.000Z',
    ...overrides,
  };
}
