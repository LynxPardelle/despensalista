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
const integration = 'despensalista';
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
      mode: settings.mode,
      hasPlus: Boolean(
        !record?.closed &&
        record?.status === 'active' &&
        record.paidThrough &&
        record.paidThrough > epochSeconds(),
      ),
      ...(record?.paidThrough && {
        currentPeriodEnd: new Date(record.paidThrough * 1000).toISOString(),
        cancelAtPeriodEnd: record.cancelAtPeriodEnd === true,
      }),
      canManage,
      canCheckout:
        settings.checkoutEnabled &&
        price.active &&
        canManage &&
        !record?.closed &&
        (status === 'none' ||
          (status === 'pending' && record?.status !== 'pending') ||
          isFinished(status)),
      canOpenPortal:
        canManage &&
        !record?.closed &&
        Boolean(record?.customerId && record.subscriptionId),
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
    acceptRecurringTerms = false,
  ): Promise<{ url: string }> {
    const settings = await this.settingsForOrigin(origin);
    if (!settings.checkoutEnabled) {
      throw new ServiceUnavailableException(
        'New subscriptions are unavailable',
      );
    }
    if (settings.mode === 'live' && !acceptRecurringTerms) {
      throw new BadRequestException('Recurring payment terms must be accepted');
    }
    const access = await this.access.executeOwner(userId);
    if (access.pantryOwnerUserId !== userId) {
      throw new ForbiddenException('Only household owners can manage billing');
    }
    await this.getPrice(settings, true);
    const { householdId } = access;
    const lease = await this.store.beginCheckout(settings.table, householdId);
    if (!lease) {
      throw new ConflictException('Checkout is busy, please retry');
    }
    try {
      return await this.createCheckout(settings, householdId);
    } finally {
      await this.store.endCheckout(settings.table, householdId, lease);
    }
  }

  private async createCheckout(
    settings: StripeBillingSettings,
    householdId: string,
  ): Promise<{ url: string }> {
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
        this.assertSession(settings, session, record);
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
      const metadata = this.metadata(settings, householdId);
      const session = await stripeRequest(() =>
        settings.stripe.checkout.sessions.create(
          {
            mode: 'subscription',
            integration_identifier: `despensalista-${settings.stage}-plus-abfcmqyt`,
            customer: record.customerId!,
            client_reference_id: householdId,
            line_items: [{ price: settings.priceId, quantity: 1 }],
            expires_at: attempt.expiresAt,
            metadata: { ...metadata, [checkoutMetadata]: attempt.token },
            subscription_data: { metadata },
            success_url: `${settings.origin}/profile?billing=success`,
            cancel_url: `${settings.origin}/profile?billing=cancelled`,
          },
          {
            idempotencyKey: `despensalista-${settings.stage}-checkout:${attempt.token}`,
          },
        ),
      );
      this.assertSession(settings, session, reserved);
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
    if (!customerId || !record.subscriptionId || record.closed) {
      throw new ConflictException('This household has no billing history');
    }
    if (settings.mode === 'live') {
      await this.getLiveCustomer(settings, customerId, household.id);
      const portalId = settings.portalConfigurationId!;
      const portal = await stripeRequest(() =>
        settings.stripe.billingPortal.configurations.retrieve(portalId),
      );
      if (
        portal.id !== portalId ||
        !portal.active ||
        !portal.livemode ||
        !portal.features.invoice_history.enabled ||
        !portal.features.payment_method_update.enabled ||
        !portal.features.subscription_cancel.enabled ||
        portal.features.subscription_cancel.mode !== 'at_period_end' ||
        portal.features.subscription_update.enabled
      ) {
        throw new ServiceUnavailableException('Billing portal is unavailable');
      }
    }
    const session = await stripeRequest(() =>
      settings.stripe.billingPortal.sessions.create({
        customer: customerId,
        configuration: settings.portalConfigurationId,
        return_url: `${settings.origin}/profile?billing=portal`,
      }),
    );
    if (
      session.livemode !== (settings.mode === 'live') ||
      session.customer !== customerId
    ) {
      throw new ServiceUnavailableException('Billing portal is unavailable');
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
    const mappedHousehold =
      settings.mode === 'live'
        ? await this.store.readHouseholdByCustomer(
            settings.table,
            signal.customerId,
          )
        : undefined;
    if (settings.mode === 'live' && !mappedHousehold) {
      return;
    }
    const customer = await stripeRequest(() =>
      settings.stripe.customers.retrieve(signal.customerId),
    );
    if (
      customer.deleted ||
      customer.id !== signal.customerId ||
      customer.livemode !== (settings.mode === 'live') ||
      !this.ownsMetadata(settings, customer.metadata)
    ) {
      return;
    }
    const householdId = customer.metadata[householdMetadata];
    if (
      !householdId ||
      (mappedHousehold !== undefined && mappedHousehold !== householdId) ||
      !(await this.households.findHouseholdById(householdId))
    ) {
      return;
    }
    for (let retry = 0; retry < maxConcurrentRetries; retry++) {
      const record = await this.store.read(settings.table, householdId);
      if (!record || record.closed || record.customerId !== customer.id) {
        return;
      }
      // Read the current Stripe state after the versioned row. If another
      // delivery changes the row, retry both reads with the new version.
      const subscription = await this.currentSubscription(settings, record);
      const checkoutSession =
        signal.checkout &&
        this.ownsMetadata(settings, signal.checkout.metadata, householdId)
          ? signal.checkout
          : undefined;
      const checkout = finishAttempt(
        record.checkout,
        checkoutSession,
        subscription,
        event.type,
      );
      const saved = await this.store.applyEvent(
        {
          ...record,
          revision: record.revision + 1,
          checkout,
          status:
            settings.mode === 'live' &&
            subscription &&
            !matchesPlan(settings, subscription)
              ? 'pending'
              : subscriptionStatus(subscription),
          subscriptionId: subscription?.id,
          paidThrough: paidThrough(settings, subscription, customer.id),
          cancelAtPeriodEnd:
            subscription?.cancel_at_period_end === true ||
            (subscription?.cancel_at != null &&
              subscription.cancel_at ===
                subscription.items?.data[0]?.current_period_end),
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

  private async getPrice(settings: StripeBillingSettings, forCheckout = false) {
    const price = await stripeRequest(() =>
      settings.stripe.prices.retrieve(settings.priceId),
    );
    if (
      price.id !== settings.priceId ||
      price.livemode !== (settings.mode === 'live') ||
      (settings.mode === 'live' &&
        stripeId(price.product) !== settings.productId) ||
      (forCheckout && !price.active) ||
      price.currency !== 'mxn' ||
      price.unit_amount === null ||
      price.unit_amount <= 0 ||
      price.recurring?.interval !== 'month' ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== 'licensed'
    ) {
      throw new ServiceUnavailableException('Billing plan is unavailable');
    }
    if (forCheckout && settings.mode === 'live') {
      const product = await stripeRequest(() =>
        settings.stripe.products.retrieve(settings.productId!),
      );
      if (
        product.id !== settings.productId ||
        !product.active ||
        !product.livemode ||
        product.metadata.integration !== integration ||
        product.metadata.stage !== settings.stage
      ) {
        throw new ServiceUnavailableException('Billing plan is unavailable');
      }
    }
    return { unit_amount: price.unit_amount, active: price.active };
  }

  private async ensureCustomer(
    settings: StripeBillingSettings,
    householdId: string,
  ) {
    for (let retry = 0; retry < maxConcurrentRetries; retry++) {
      let record = await this.store.read(settings.table, householdId);
      if (record?.customerId) {
        if (settings.mode === 'live') {
          await this.getLiveCustomer(settings, record.customerId, householdId);
        }
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
          'Billing customer requires reconciliation',
        );
      }
      const customer = await stripeRequest(() =>
        settings.stripe.customers.create(
          { metadata: this.metadata(settings, householdId) },
          {
            idempotencyKey: `despensalista-${settings.stage}-customer:${householdId}`,
          },
        ),
      );
      if (
        customer.livemode !== (settings.mode === 'live') ||
        !this.ownsMetadata(settings, customer.metadata, householdId)
      ) {
        throw new ServiceUnavailableException('Billing customer is invalid');
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
      'Billing customer is busy, please retry',
    );
  }

  private metadata(
    settings: StripeBillingSettings,
    householdId: string,
  ): Stripe.MetadataParam {
    return settings.mode === 'live'
      ? { [householdMetadata]: householdId, integration, stage: settings.stage }
      : { [householdMetadata]: householdId };
  }

  private ownsMetadata(
    settings: StripeBillingSettings,
    metadata: Stripe.Metadata | null,
    householdId?: string,
  ): boolean {
    return Boolean(
      metadata?.[householdMetadata] &&
      (householdId === undefined ||
        metadata[householdMetadata] === householdId) &&
      ((metadata.integration === integration &&
        metadata.stage === settings.stage) ||
        (settings.mode === 'test' && !metadata.integration && !metadata.stage)),
    );
  }

  private async getLiveCustomer(
    settings: StripeBillingSettings,
    customerId: string,
    householdId: string,
  ) {
    const customer = await stripeRequest(() =>
      settings.stripe.customers.retrieve(customerId),
    );
    if (
      customer.deleted ||
      customer.id !== customerId ||
      !customer.livemode ||
      !this.ownsMetadata(settings, customer.metadata, householdId)
    ) {
      throw new ServiceUnavailableException('Billing customer is invalid');
    }
    return customer;
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
            subscription.livemode === (settings.mode === 'live') &&
            this.ownsMetadata(
              settings,
              subscription.metadata,
              record.householdId,
            ) &&
            (settings.mode === 'test' ||
              stripeId(subscription.customer) === record.customerId)
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
    settings: StripeBillingSettings,
    session: Stripe.Checkout.Session,
    record: BillingRecord,
  ): void {
    if (
      session.livemode !== (settings.mode === 'live') ||
      stripeId(session.customer) !== record.customerId ||
      session.mode !== 'subscription' ||
      !this.ownsMetadata(settings, session.metadata, record.householdId) ||
      session.metadata?.[checkoutMetadata] !== record.checkout?.token
    ) {
      throw new ServiceUnavailableException('Stripe Checkout is unavailable');
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
    if (
      event.livemode !== (settings.mode === 'live') ||
      (event.account !== undefined &&
        settings.accountId !== undefined &&
        event.account !== settings.accountId) ||
      !/^evt_[a-zA-Z0-9_]+$/.test(event.id)
    ) {
      throw new BadRequestException('Unexpected Stripe event environment');
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

function matchesPlan(
  settings: StripeBillingSettings,
  subscription: Stripe.Subscription,
): boolean {
  const item = subscription.items?.data[0];
  return Boolean(
    item &&
    !subscription.items.has_more &&
    subscription.items.data.length === 1 &&
    item.quantity === 1 &&
    item.price.id === settings.priceId &&
    (settings.mode === 'test' ||
      stripeId(item.price.product) === settings.productId),
  );
}

function paidThrough(
  settings: StripeBillingSettings,
  subscription: Stripe.Subscription | undefined,
  customerId: string,
): number | undefined {
  if (
    !subscription ||
    subscription.status !== 'active' ||
    !matchesPlan(settings, subscription)
  ) {
    return undefined;
  }
  const invoice = subscription.latest_invoice;
  const item = subscription.items.data[0];
  if (
    !invoice ||
    typeof invoice === 'string' ||
    invoice.status !== 'paid' ||
    invoice.livemode !== (settings.mode === 'live') ||
    invoice.amount_paid <= 0 ||
    invoice.currency !== 'mxn' ||
    stripeId(invoice.customer) !== customerId ||
    stripeId(invoice.parent?.subscription_details?.subscription ?? null) !==
      subscription.id
  ) {
    return undefined;
  }
  const line = invoice.lines?.data.find(
    (line) =>
      stripeId(
        line.parent?.subscription_item_details?.subscription_item ?? null,
      ) === item.id &&
      stripeId(line.pricing?.price_details?.price ?? null) ===
        settings.priceId &&
      line.period.end === item.current_period_end &&
      line.currency === 'mxn' &&
      line.amount > 0,
  );
  return line && Number.isSafeInteger(item.current_period_end)
    ? item.current_period_end
    : undefined;
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
  throw new ServiceUnavailableException('Billing redirect is unavailable');
}

async function stripeRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch {
    throw new ServiceUnavailableException('Stripe is unavailable');
  }
}
