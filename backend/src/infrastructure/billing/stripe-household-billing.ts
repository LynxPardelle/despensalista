import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type Stripe from 'stripe';
import type { HouseholdBilling } from '../../application/ports/household-billing.port';
import {
  StripeBillingConfig,
  type StripeBillingSettings,
} from './stripe-billing-config';
import { StripeBillingStore } from './stripe-billing.store';

@Injectable()
export class StripeHouseholdBilling implements HouseholdBilling {
  constructor(
    private readonly config: StripeBillingConfig,
    private readonly store: StripeBillingStore,
  ) {}

  async stopRenewals(householdId: string): Promise<void> {
    const settings = await this.config.get();
    if (!settings) return;

    try {
      if (!(await this.store.beginClosure(settings.table, householdId))) {
        throw this.retryClosure();
      }
      const record = await this.store.read(settings.table, householdId);
      if (!record || record.closed) return;
      if (record.customerId) {
        await this.stopStripeRenewals(settings, householdId, record.customerId);
      }
      if (!(await this.store.finishClosure(settings.table, record))) {
        throw this.retryClosure();
      }
    } catch {
      // The durable account deletion job retries. Never log Stripe objects,
      // which may contain customer details and hosted session URLs.
      throw this.retryClosure();
    }
  }

  private async stopStripeRenewals(
    settings: StripeBillingSettings,
    householdId: string,
    customerId: string,
  ): Promise<void> {
    const isLive = settings.mode === 'live';
    const owns = (metadata: Stripe.Metadata | null | undefined) =>
      metadata?.despensalistaHouseholdId === householdId &&
      ((metadata.integration === 'despensalista' &&
        metadata.stage === settings.stage) ||
        (!isLive && !metadata.integration && !metadata.stage));

    const customer = await settings.stripe.customers.retrieve(customerId);
    if (customer.id !== customerId) throw this.retryClosure();
    // Stripe cancels active subscriptions when a customer is deleted. The
    // customer link here comes from our own versioned billing record.
    if (customer.deleted) return;
    if (customer.livemode !== isLive || !owns(customer.metadata))
      throw this.retryClosure();

    // Expire Checkout first. If it completes concurrently, leave the durable
    // job pending so the next attempt can see and cancel the new subscription.
    await forEachPage(
      (startingAfter) =>
        settings.stripe.checkout.sessions.list({
          customer: customerId,
          status: 'open',
          limit: 25,
          starting_after: startingAfter,
        }),
      async (session) => {
        if (
          stripeId(session.customer) !== customerId ||
          session.livemode !== isLive ||
          session.mode !== 'subscription' ||
          !owns(session.metadata)
        )
          throw this.retryClosure();
        const expired = await settings.stripe.checkout.sessions.expire(
          session.id,
        );
        if (expired.id !== session.id || expired.status !== 'expired')
          throw this.retryClosure();
      },
    );

    await forEachPage(
      (startingAfter) =>
        settings.stripe.subscriptions.list({
          customer: customerId,
          status: 'all',
          limit: 25,
          starting_after: startingAfter,
        }),
      async (subscription) => {
        if (
          subscription.status === 'canceled' ||
          subscription.status === 'incomplete_expired'
        )
          return;
        if (
          stripeId(subscription.customer) !== customerId ||
          subscription.livemode !== isLive ||
          !owns(subscription.metadata)
        )
          throw this.retryClosure();
        const plus = subscription.items.data.some(({ price }) =>
          settings.productId
            ? stripeId(price.product) === settings.productId
            : price.id === settings.priceId,
        );
        if (!plus) throw this.retryClosure();
        const canceled = await settings.stripe.subscriptions.cancel(
          subscription.id,
          {
            invoice_now: false,
            prorate: false,
          },
        );
        if (canceled.id !== subscription.id || canceled.status !== 'canceled')
          throw this.retryClosure();
      },
    );
  }

  private retryClosure(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Household billing closure will retry',
    );
  }
}

function stripeId(
  value: string | { id: string } | null | undefined,
): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

async function forEachPage<T extends { id: string }>(
  list: (
    startingAfter: string | undefined,
  ) => Promise<{ data: T[]; has_more: boolean }>,
  action: (record: T) => Promise<void>,
): Promise<void> {
  let startingAfter: string | undefined;
  for (;;) {
    const page = await list(startingAfter);
    for (const record of page.data) await action(record);
    if (!page.has_more) return;
    const last = page.data.at(-1)?.id;
    if (!last || last === startingAfter)
      throw new Error('Invalid Stripe page cursor');
    startingAfter = last;
  }
}
