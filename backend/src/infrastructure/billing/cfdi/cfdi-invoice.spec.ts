import type Stripe from 'stripe';
import { cfdiInvoice } from './cfdi-invoice';

const settings = {
  mode: 'live' as const,
  stage: 'prod' as const,
  priceId: 'price_BasePlus',
  productId: 'prod_DespensaPlus',
};
const owner = { householdId: 'home', customerId: 'cus_OurHome' };

function stripeInvoice(overrides: object = {}): Stripe.Invoice {
  return {
    id: 'in_OurInvoice',
    customer: owner.customerId,
    status: 'paid',
    livemode: true,
    billing_reason: 'subscription_cycle',
    collection_method: 'charge_automatically',
    amount_paid: 6844,
    total: 6844,
    total_excluding_tax: 5900,
    total_taxes: [{ amount: 944 }],
    currency: 'mxn',
    status_transitions: { paid_at: 1794768802 },
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: 'sub_OurHome',
        metadata: {
          despensalistaHouseholdId: owner.householdId,
          integration: 'despensalista',
          stage: 'prod',
        },
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          amount: 5900,
          currency: 'mxn',
          quantity: 1,
          parent: {
            type: 'subscription_item_details',
            subscription_item_details: {
              subscription: 'sub_OurHome',
              proration: false,
            },
          },
          pricing: {
            price_details: {
              product: settings.productId,
              price: 'price_OldPlus',
            },
          },
        },
      ],
    },
    payments: {
      has_more: false,
      data: [
        {
          invoice: 'in_OurInvoice',
          livemode: true,
          currency: 'mxn',
          status: 'paid',
          amount_paid: 6844,
          payment: { type: 'payment_intent', payment_intent: 'pi_OurInvoice' },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

describe('el pago que permite solicitar CFDI', () => {
  it('conserva el total y desglose histórico del pago del hogar', () => {
    expect(cfdiInvoice(stripeInvoice(), settings, owner)).toEqual({
      id: 'in_OurInvoice',
      paidAt: '2026-11-15T18:53:22.000Z',
      amountMinor: 6844,
      currency: 'mxn',
      subtotalMinor: 5900,
      taxMinor: 944,
    });
  });

  it.each([
    { customer: 'cus_OtherHome' },
    { status: 'open' },
    { livemode: false },
    { parent: null },
    { payments: { has_more: false, data: [] } },
    { amount_paid: 0 },
    { billing_reason: 'manual' },
    { lines: { has_more: true, data: [] } },
  ])(
    'descarta el pago sin vínculo o evidencia exacta de cobro (%j)',
    (change) => {
      expect(
        cfdiInvoice(stripeInvoice(change), settings, owner),
      ).toBeUndefined();
    },
  );

  it('descarta un producto diferente en una cuenta Stripe compartida', () => {
    expect(
      cfdiInvoice(
        stripeInvoice(),
        { ...settings, productId: 'prod_OtherProduct' },
        owner,
      ),
    ).toBeUndefined();
  });
});
