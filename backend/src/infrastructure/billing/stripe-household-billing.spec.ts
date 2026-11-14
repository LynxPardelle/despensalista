import type Stripe from 'stripe';
import type {
  StripeBillingConfig,
  StripeBillingSettings,
} from './stripe-billing-config';
import type { StripeBillingStore } from './stripe-billing.store';
import { StripeHouseholdBilling } from './stripe-household-billing';

const householdId = 'household-1';
const table = 'despensalista-dev-billing';
const customerId = 'cus_owned';
const metadata = { despensalistaHouseholdId: householdId };
const customer = { id: customerId, livemode: false, metadata };
const session = {
  id: 'cs_test_owned',
  customer: customerId,
  livemode: false,
  mode: 'subscription',
  metadata,
  status: 'open',
};
const subscription = {
  id: 'sub_owned',
  customer: customerId,
  livemode: false,
  metadata,
  status: 'active',
  items: { data: [{ price: { id: 'price_plus' } }] },
};

describe('StripeHouseholdBilling', () => {
  it('expires Checkout and cancels the owned subscription before scrubbing billing', async () => {
    const f = fixture();
    await f.billing.stopRenewals(householdId);
    expect(f.expire).toHaveBeenCalledWith(session.id);
    expect(f.cancel).toHaveBeenCalledWith(subscription.id, {
      invoice_now: false,
      prorate: false,
    });
    expect(f.expire.mock.invocationCallOrder[0]).toBeLessThan(
      f.cancel.mock.invocationCallOrder[0],
    );
    expect(f.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      f.finishClosure.mock.invocationCallOrder[0],
    );
  });

  it('preserves billing state on failure and retries without another charge', async () => {
    const f = fixture();
    f.cancel.mockRejectedValueOnce(new Error('network failed'));
    await expect(f.billing.stopRenewals(householdId)).rejects.toThrow(
      'billing closure',
    );
    expect(f.finishClosure).not.toHaveBeenCalled();
    f.sessions.mockResolvedValue({ data: [], has_more: false });
    await f.billing.stopRenewals(householdId);
    expect(f.expire).toHaveBeenCalledTimes(1);
    expect(f.finishClosure).toHaveBeenCalledTimes(1);
  });

  it('does not change a Stripe customer belonging to another application', async () => {
    const f = fixture();
    f.retrieve.mockResolvedValue({
      ...customer,
      metadata: { integration: 'roadmap2u' },
    });
    await expect(f.billing.stopRenewals(householdId)).rejects.toThrow(
      'billing closure',
    );
    expect(f.expire).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.finishClosure).not.toHaveBeenCalled();
  });

  it('waits for another Checkout worker before accessing Stripe', async () => {
    const f = fixture();
    f.beginClosure.mockResolvedValue(false);
    await expect(f.billing.stopRenewals(householdId)).rejects.toThrow(
      'billing closure',
    );
    expect(f.retrieve).not.toHaveBeenCalled();
  });

  it('holds deletion when the owned customer has an active subscription it cannot attribute', async () => {
    const f = fixture();
    f.list.mockResolvedValue({
      data: [{ ...subscription, metadata: {} }],
      has_more: false,
    });
    await expect(f.billing.stopRenewals(householdId)).rejects.toThrow(
      'billing closure',
    );
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.finishClosure).not.toHaveBeenCalled();
  });
});

function fixture() {
  const retrieve = jest.fn().mockResolvedValue(customer);
  const sessions = jest
    .fn()
    .mockResolvedValue({ data: [session], has_more: false });
  const expire = jest.fn().mockResolvedValue({ ...session, status: 'expired' });
  const list = jest
    .fn()
    .mockResolvedValue({ data: [subscription], has_more: false });
  const cancel = jest
    .fn()
    .mockResolvedValue({ ...subscription, status: 'canceled' });
  const stripe = {
    customers: { retrieve },
    checkout: { sessions: { list: sessions, expire } },
    subscriptions: { list, cancel },
  } as unknown as Stripe;
  const settings = {
    stripe,
    priceId: 'price_plus',
    table,
    mode: 'test',
  } as StripeBillingSettings;
  const config = {
    get: jest.fn().mockResolvedValue(settings),
  } as unknown as StripeBillingConfig;
  const record = { householdId, customerId, revision: 1 };
  const beginClosure = jest.fn().mockResolvedValue(true);
  const finishClosure = jest.fn().mockResolvedValue(true);
  const store = {
    beginClosure,
    read: jest.fn().mockResolvedValue(record),
    finishClosure,
  } as unknown as StripeBillingStore;
  return {
    billing: new StripeHouseholdBilling(config, store),
    retrieve,
    sessions,
    expire,
    list,
    cancel,
    beginClosure,
    finishClosure,
  };
}
