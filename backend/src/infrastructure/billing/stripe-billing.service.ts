import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Stripe from 'stripe';
import { HOUSEHOLD_REPOSITORY } from '../../application/tokens';
import { ResolveHouseholdPantryAccessUseCase } from '../../application/use-cases/household.use-cases';
import type { HouseholdRepository } from '../../domain/repositories/household.repository';
import {
  StripeBillingConfig,
  type StripeBillingSettings,
} from './stripe-billing-config';
import { StripeBillingStore, type BillingRecord } from './stripe-billing.store';

const householdMetadata = 'despensalistaHouseholdId';
const checkoutMetadata = 'despensalistaCheckoutToken';
const checkoutDuration = 2 * 60 * 60;
const checkoutMinimumRemaining = 31 * 60;
const customerIdempotencyWindow = 23 * 60 * 60;
const maxConcurrentRetries = 6;

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

@Injectable()
export class StripeBillingService {
  constructor(
    private readonly config: StripeBillingConfig,
    private readonly store: StripeBillingStore,
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly households: HouseholdRepository,
    private readonly access: ResolveHouseholdPantryAccessUseCase,
  ) {}

  async status(userId: string) {
    const settings = await this.config.get();
    if (!settings) {
      return { available: false, canManage: false };
    }
    const membership = await this.households.findMembershipByUserId(userId);
    const household = membership
      ? await this.households.findHouseholdById(membership.householdId)
      : null;
    const canManage =
      !membership ||
      Boolean(membership.role === 'owner' && household?.ownerUserId === userId);
    const [price, record] = await Promise.all([
      this.getPrice(settings),
      household ? this.store.read(settings.table, household.id) : undefined,
    ]);
    const status =
      record?.status && !isFinished(record.status)
        ? record.status
        : record?.checkout && record.checkout.expiresAt > epochSeconds()
          ? 'pending'
          : (record?.status ?? 'none');
    return {
      available: true,
      canManage,
      canCheckout:
        canManage &&
        (status === 'none' ||
          (status === 'pending' && record?.status !== 'pending') ||
          isFinished(status)),
      canOpenPortal:
        canManage && Boolean(record?.customerId && record.subscriptionId),
      status,
      plan: {
        label: 'Plus Hogar',
        amountMinor: price.unit_amount,
        currency: 'mxn',
        interval: 'month',
      },
    };
  }

  async checkout(
    userId: string,
    origin: string | undefined,
  ): Promise<{ url: string }> {
    const settings = await this.settingsForOrigin(origin);
    const access = await this.access.executeOwner(userId);
    if (access.pantryOwnerUserId !== userId) {
      throw new ForbiddenException('Only household owners can manage billing');
    }
    await this.getPrice(settings);
    const { householdId } = access;
    for (let retry = 0; retry < maxConcurrentRetries; retry++) {
      const record = await this.ensureCustomer(settings, householdId);
      const subscription = await this.currentSubscription(settings, record);
      if (subscription && !isFinished(subscription.status)) {
        throw new ConflictException(
          'This household already has a subscription',
        );
      }

      const open = record.checkout;
      const now = epochSeconds();
      const sessionId = open?.stripeSessionId;
      if (sessionId) {
        const session = await stripeRequest(() =>
          settings.stripe.checkout.sessions.retrieve(sessionId),
        );
        this.assertSession(session, record);
        if (session.status === 'open') {
          return { url: stripeUrl(session.url, 'checkout.stripe.com') };
        }
        if (
          session.status === 'complete' &&
          (!subscription || subscription.id !== stripeId(session.subscription))
        ) {
          throw new ConflictException('Checkout is awaiting confirmation');
        }
      }

      const reuse = open && !open.stripeSessionId && open.expiresAt > now;
      const attempt = reuse
        ? open
        : { token: randomUUID(), expiresAt: now + checkoutDuration };
      if (attempt.expiresAt < now + checkoutMinimumRemaining) {
        throw new ConflictException('Checkout is awaiting expiration');
      }
      const reserved = reuse
        ? record
        : { ...record, revision: record.revision + 1, checkout: attempt };
      if (!reuse && !(await this.store.save(reserved, settings.table))) {
        continue;
      }
      const metadata = { [householdMetadata]: householdId };
      const session = await stripeRequest(() =>
        settings.stripe.checkout.sessions.create(
          {
            mode: 'subscription',
            integration_identifier: 'despensalista-dev-plus-abfcmqyt',
            customer: record.customerId!,
            client_reference_id: householdId,
            line_items: [{ price: settings.priceId, quantity: 1 }],
            expires_at: attempt.expiresAt,
            metadata: { ...metadata, [checkoutMetadata]: attempt.token },
            subscription_data: { metadata },
            success_url: `${settings.origin}/profile?billing=success`,
            cancel_url: `${settings.origin}/profile?billing=cancelled`,
          },
          { idempotencyKey: `despensalista-dev-checkout:${attempt.token}` },
        ),
      );
      this.assertSession(session, reserved);
      if (session.status !== 'open') {
        throw new ConflictException('Checkout is awaiting confirmation');
      }
      const url = stripeUrl(session.url, 'checkout.stripe.com');
      const saved = await this.store.save(
        {
          ...reserved,
          revision: reserved.revision + 1,
          checkout: { ...attempt, stripeSessionId: session.id },
        },
        settings.table,
      );
      if (saved) {
        return { url };
      }
    }
    throw new ServiceUnavailableException('Checkout is busy, please retry');
  }

  async portal(
    userId: string,
    origin: string | undefined,
  ): Promise<{ url: string }> {
    const settings = await this.settingsForOrigin(origin);
    const member = await this.households.findMembershipByUserId(userId);
    const household =
      member && (await this.households.findHouseholdById(member.householdId));
    if (
      !household ||
      member.role !== 'owner' ||
      household.ownerUserId !== userId
    ) {
      throw new ForbiddenException('Only household owners can manage billing');
    }
    const record = await this.store.read(settings.table, household.id);
    const customerId = record?.customerId;
    if (!customerId || !record.subscriptionId) {
      throw new ConflictException('This household has no billing history');
    }
    const session = await stripeRequest(() =>
      settings.stripe.billingPortal.sessions.create({
        customer: customerId,
        configuration: settings.portalConfigurationId,
        return_url: `${settings.origin}/profile?billing=portal`,
      }),
    );
    if (session.livemode !== false || session.customer !== customerId) {
      throw new ServiceUnavailableException('Sandbox portal is unavailable');
    }
    return { url: stripeUrl(session.url, 'billing.stripe.com') };
  }

  async webhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<void> {
    const settings = await this.config.get();
    if (!settings) {
      throw new NotFoundException();
    }
    const event = this.verifyEvent(settings, rawBody, signature);
    const signal = billingSignal(event);
    if (!signal || (await this.store.hasEvent(settings.table, event.id))) {
      return;
    }
    const customer = await stripeRequest(() =>
      settings.stripe.customers.retrieve(signal.customerId),
    );
    if (customer.deleted || customer.livemode !== false) {
      return;
    }
    const householdId = customer.metadata[householdMetadata];
    if (
      !householdId ||
      !(await this.households.findHouseholdById(householdId))
    ) {
      return;
    }
    for (let retry = 0; retry < maxConcurrentRetries; retry++) {
      const record = await this.store.read(settings.table, householdId);
      if (!record || record.customerId !== customer.id) {
        return;
      }
      // Read the current Stripe state after the versioned row. If another
      // delivery changes the row, retry both reads with the new version.
      const subscription = await this.currentSubscription(settings, record);
      const checkout = finishAttempt(
        record.checkout,
        signal.checkout,
        subscription,
        event.type,
      );
      const saved = await this.store.applyEvent(
        {
          ...record,
          revision: record.revision + 1,
          checkout,
          status: subscriptionStatus(subscription),
          subscriptionId: subscription?.id,
        },
        settings.table,
        event.id,
      );
      if (saved) {
        return;
      }
    }
    throw new ServiceUnavailableException(
      'Billing reconciliation is busy, please retry',
    );
  }

  private async settingsForOrigin(
    origin: string | undefined,
  ): Promise<StripeBillingSettings> {
    const settings = await this.config.get();
    if (!settings) {
      throw new NotFoundException();
    }
    if (origin !== settings.origin) {
      throw new ForbiddenException('Invalid billing origin');
    }
    return settings;
  }

  private async getPrice(settings: StripeBillingSettings) {
    const price = await stripeRequest(() =>
      settings.stripe.prices.retrieve(settings.priceId),
    );
    if (
      price.livemode !== false ||
      !price.active ||
      price.currency !== 'mxn' ||
      price.unit_amount === null ||
      price.unit_amount <= 0 ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed'
    ) {
      throw new ServiceUnavailableException('Sandbox plan is unavailable');
    }
    return { unit_amount: price.unit_amount };
  }

  private async ensureCustomer(
    settings: StripeBillingSettings,
    householdId: string,
  ) {
    for (let retry = 0; retry < maxConcurrentRetries; retry++) {
      let record = await this.store.read(settings.table, householdId);
      if (record?.customerId) {
        return record;
      }
      const now = epochSeconds();
      if (!record) {
        record = { householdId, revision: 1, customerCreationStartedAt: now };
        if (!(await this.store.save(record, settings.table))) {
          continue;
        }
      }
      if (
        now - (record.customerCreationStartedAt ?? 0) >=
        customerIdempotencyWindow
      ) {
        // Stripe can prune a key at 24 hours. An unresolved old operation
        // requires reconciliation before another customer can be created.
        throw new ServiceUnavailableException(
          'Sandbox customer requires reconciliation',
        );
      }
      const customer = await stripeRequest(() =>
        settings.stripe.customers.create(
          { metadata: { [householdMetadata]: householdId } },
          { idempotencyKey: `despensalista-dev-customer:${householdId}` },
        ),
      );
      if (
        customer.livemode !== false ||
        customer.metadata[householdMetadata] !== householdId
      ) {
        throw new ServiceUnavailableException('Sandbox customer is invalid');
      }
      const next = {
        ...record,
        revision: record.revision + 1,
        customerId: customer.id,
      };
      if (await this.store.save(next, settings.table)) {
        return next;
      }
    }
    throw new ServiceUnavailableException(
      'Sandbox customer is busy, please retry',
    );
  }

  private async currentSubscription(
    settings: StripeBillingSettings,
    record: BillingRecord,
  ) {
    if (!record.customerId) {
      return undefined;
    }
    return stripeRequest(async () => {
      const params: Stripe.SubscriptionListParams = {
        customer: record.customerId,
        status: 'all',
        expand: ['data.latest_invoice'],
        limit: 25,
      };
      // Most households have one subscription. Paginate only if Stripe has
      // more results so a sufficiently old active subscription cannot hide.
      let selected: Stripe.Subscription | undefined;
      let page = await settings.stripe.subscriptions.list(params);
      while (true) {
        for (const subscription of page.data) {
          if (
            subscription.livemode === false &&
            subscription.metadata[householdMetadata] === record.householdId
          ) {
            if (!isFinished(subscription.status)) {
              return subscription;
            }
            selected ??= subscription;
          }
        }
        const last = page.data.at(-1);
        if (!page.has_more || !last) {
          return selected;
        }
        page = await settings.stripe.subscriptions.list({
          ...params,
          starting_after: last.id,
        });
      }
    });
  }

  private assertSession(
    session: Stripe.Checkout.Session,
    record: BillingRecord,
  ): void {
    if (
      session.livemode !== false ||
      stripeId(session.customer) !== record.customerId ||
      session.mode !== 'subscription' ||
      session.metadata?.[householdMetadata] !== record.householdId ||
      session.metadata?.[checkoutMetadata] !== record.checkout?.token
    ) {
      throw new ServiceUnavailableException('Sandbox Checkout is unavailable');
    }
  }

  private verifyEvent(
    settings: StripeBillingSettings,
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Stripe.Event {
    if (!rawBody || !signature) {
      throw new BadRequestException('Stripe signature is required');
    }
    let event: Stripe.Event;
    try {
      event = settings.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        settings.webhookSigningSecret,
      );
    } catch {
      throw new BadRequestException('Invalid Stripe signature');
    }
    if (event.livemode !== false || !/^evt_[a-zA-Z0-9_]+$/.test(event.id)) {
      throw new BadRequestException('Expected a Stripe sandbox event');
    }
    return event;
  }
}

function isFinished(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

function subscriptionStatus(
  subscription: Stripe.Subscription | undefined,
): BillingRecord['status'] {
  if (subscription?.status === 'active') {
    const invoice = subscription.latest_invoice;
    if (!invoice || typeof invoice === 'string' || invoice.status !== 'paid') {
      return 'pending';
    }
  }
  return subscription?.status;
}

function billingSignal(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired': {
      const checkout = event.data.object;
      const customerId = stripeId(checkout.customer);
      return customerId && checkout.mode === 'subscription'
        ? { customerId, checkout }
        : undefined;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const customerId = stripeId(event.data.object.customer);
      return customerId ? { customerId, checkout: undefined } : undefined;
    }
    default:
      return undefined;
  }
}

function finishAttempt(
  attempt: BillingRecord['checkout'],
  session: Stripe.Checkout.Session | undefined,
  subscription: Stripe.Subscription | undefined,
  eventType: Stripe.Event.Type,
): BillingRecord['checkout'] {
  if (
    !attempt ||
    !session ||
    session.metadata?.[checkoutMetadata] !== attempt.token
  ) {
    return attempt;
  }
  if (
    eventType === 'checkout.session.expired' ||
    eventType === 'checkout.session.async_payment_failed' ||
    (subscription &&
      (session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required'))
  ) {
    return undefined;
  }
  return { ...attempt, stripeSessionId: session.id };
}

function stripeId(value: { id: string } | string | null): string | undefined {
  return typeof value === 'string' ? value : value?.id;
}

function stripeUrl(raw: string | null, expectedHost: string): string {
  if (raw && URL.canParse(raw)) {
    const url = new URL(raw);
    if (
      url.origin === `https://${expectedHost}` &&
      !url.username &&
      !url.password
    ) {
      return url.href;
    }
  }
  throw new ServiceUnavailableException(
    'Sandbox billing redirect is unavailable',
  );
}

async function stripeRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch {
    throw new ServiceUnavailableException('Stripe sandbox is unavailable');
  }
}
