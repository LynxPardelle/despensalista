import type Stripe from 'stripe';
import type { StripeBillingSettings } from '../stripe-billing-config';

export const stripeInvoiceId = /^in_[a-zA-Z0-9]{1,128}$/;

type CfdiStripeSettings = Pick<
  StripeBillingSettings,
  'mode' | 'stage' | 'productId' | 'priceId'
>;

export interface CfdiInvoice {
  id: string;
  paidAt: string;
  amountMinor: number;
  currency: 'mxn';
  subtotalMinor: number;
  taxMinor: number;
}

export function cfdiInvoice(
  invoice: Stripe.Invoice,
  settings: CfdiStripeSettings,
  owner: { householdId: string; customerId: string },
): CfdiInvoice | undefined {
  const live = settings.mode === 'live';
  const paidAt = invoice.status_transitions.paid_at;
  if (
    !stripeInvoiceId.test(invoice.id) ||
    invoice.livemode !== live ||
    stripeId(invoice.customer) !== owner.customerId ||
    invoice.status !== 'paid' ||
    invoice.currency !== 'mxn' ||
    invoice.collection_method !== 'charge_automatically' ||
    (invoice.billing_reason !== 'subscription_create' &&
      invoice.billing_reason !== 'subscription_cycle') ||
    !Number.isSafeInteger(invoice.amount_paid) ||
    invoice.amount_paid <= 0 ||
    invoice.amount_paid !== invoice.total ||
    typeof paidAt !== 'number' ||
    !Number.isSafeInteger(paidAt) ||
    paidAt <= 0 ||
    paidAt > 8_640_000_000_000
  ) {
    return undefined;
  }

  const subscription = invoice.parent?.subscription_details;
  const subscriptionId = stripeId(subscription?.subscription);
  const metadata = subscription?.metadata;
  if (
    invoice.parent?.type !== 'subscription_details' ||
    !subscriptionId ||
    !/^sub_[a-zA-Z0-9]+$/.test(subscriptionId) ||
    metadata?.despensalistaHouseholdId !== owner.householdId ||
    !(
      (metadata.integration === 'despensalista' &&
        metadata.stage === settings.stage) ||
      (!live && !metadata.integration && !metadata.stage)
    )
  ) {
    return undefined;
  }

  const [line] = invoice.lines.data;
  const price = line?.pricing?.price_details;
  if (
    invoice.lines.has_more ||
    invoice.lines.data.length !== 1 ||
    !line ||
    line.quantity !== 1 ||
    line.currency !== 'mxn' ||
    line.amount <= 0 ||
    line.parent?.type !== 'subscription_item_details' ||
    line.parent.subscription_item_details?.subscription !== subscriptionId ||
    line.parent.subscription_item_details.proration ||
    (live
      ? !settings.productId || price?.product !== settings.productId
      : stripeId(price?.price) !== settings.priceId)
  ) {
    return undefined;
  }

  const payment = invoice.payments?.data.find(
    (entry) =>
      stripeId(entry.invoice) === invoice.id &&
      entry.livemode === live &&
      entry.currency === 'mxn' &&
      entry.status === 'paid' &&
      entry.amount_paid === invoice.amount_paid &&
      ((entry.payment.type === 'payment_intent' &&
        Boolean(stripeId(entry.payment.payment_intent))) ||
        (entry.payment.type === 'charge' &&
          Boolean(stripeId(entry.payment.charge)))),
  );
  if (invoice.payments?.has_more || !payment) return undefined;

  const subtotalMinor = invoice.total_excluding_tax;
  if (
    typeof subtotalMinor !== 'number' ||
    !Number.isSafeInteger(subtotalMinor) ||
    subtotalMinor <= 0 ||
    subtotalMinor > invoice.total
  ) {
    return undefined;
  }
  const taxMinor = invoice.total - subtotalMinor;
  if (
    (invoice.total_taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0) !==
    taxMinor
  ) {
    return undefined;
  }

  return {
    id: invoice.id,
    paidAt: new Date(paidAt * 1000).toISOString(),
    amountMinor: invoice.amount_paid,
    currency: 'mxn',
    subtotalMinor,
    taxMinor,
  };
}

function stripeId(value?: string | { id: string } | null): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}
