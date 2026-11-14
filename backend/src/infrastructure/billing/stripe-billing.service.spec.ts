// eslint-disable-next-line @typescript-eslint/no-require-imports -- Match the backend's Stripe CommonJS import.
import Stripe = require('stripe');
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { HouseholdRepository } from '../../domain/repositories/household.repository';
import type { ResolveHouseholdPantryAccessUseCase } from '../../application/use-cases/household.use-cases';
import { StripeBillingController } from '../http/controllers/stripe-billing.controller';
import { AccessTokenGuard } from '../http/auth/access-token.guard';
import type { StripeBillingConfig } from './stripe-billing-config';
import { StripeBillingService } from './stripe-billing.service';
import type { BillingRecord, StripeBillingStore } from './stripe-billing.store';

describe('StripeBillingService', () => {
  const secret = 'whsec_unit_test_secret';
  const stripe = new Stripe('sk_test_unit_test_key');
  const billing = {
    stripe,
    mode: 'test',
    stage: 'dev',
    checkoutEnabled: true,
    origin: 'https://dev.despensalista.lynxpardelle.com',
    table: 'despensalista-dev-billing',
    priceId: 'price_test',
    webhookSigningSecret: secret,
  };
  const production = {
    ...billing,
    mode: 'live',
    stage: 'prod',
    origin: 'https://despensalista.com',
    table: 'despensalista-prod-billing',
    accountId: 'acct_despensa',
    productId: 'prod_despensa',
    portalConfigurationId: 'bpc_despensa',
    checkoutEnabled: false,
  };
  const session = {
    id: 'cs_test_thissession',
    customer: 'cus_test',
    livemode: false,
    metadata: { despensalistaHouseholdId: 'household-1' },
    mode: 'subscription',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_test_thissession',
  } as const;
  let record: BillingRecord | undefined;
  let service: StripeBillingService;
  let exists: jest.Mock;
  let commit: jest.Mock;
  let membership: jest.Mock;
  let permissions: jest.Mock;
  let settings: jest.Mock;
  let customerMapping: jest.Mock;
  let beginCheckout: jest.Mock;
  let endCheckout: jest.Mock;

  beforeEach(() => {
    record = undefined;
    exists = jest.fn().mockResolvedValue(false);
    settings = jest.fn().mockResolvedValue(billing);
    customerMapping = jest.fn().mockResolvedValue(undefined);
    beginCheckout = jest.fn().mockResolvedValue('lease');
    endCheckout = jest.fn().mockResolvedValue(undefined);
    commit = jest.fn().mockImplementation((next: BillingRecord) => {
      record = next;
      return Promise.resolve(true);
    });
    const store = {
      read: jest.fn().mockImplementation(() => Promise.resolve(record)),
      save: jest.fn().mockImplementation((next: BillingRecord) => {
        if (next.revision !== (record?.revision ?? 0) + 1) {
          return Promise.resolve(false);
        }
        record = next;
        return Promise.resolve(true);
      }),
      hasEvent: exists,
      readHouseholdByCustomer: customerMapping,
      beginCheckout,
      endCheckout,
      applyEvent: commit,
    } as unknown as StripeBillingStore;
    membership = jest.fn().mockResolvedValue(null);
    permissions = jest.fn().mockResolvedValue({
      householdId: 'household-1',
      pantryOwnerUserId: 'owner-1',
    });
    service = new StripeBillingService(
      {
        get: settings,
      } as unknown as StripeBillingConfig,
      store,
      {
        findMembershipByUserId: membership,
        findHouseholdById: jest
          .fn()
          .mockResolvedValue({ id: 'household-1', ownerUserId: 'owner-1' }),
      } as unknown as HouseholdRepository,
      {
        executeOwner: permissions,
      } as unknown as ResolveHouseholdPantryAccessUseCase,
    );
    jest.spyOn(stripe.prices, 'retrieve').mockResolvedValue({
      id: 'price_test',
      active: true,
      livemode: false,
      currency: 'mxn',
      unit_amount: 5900,
      recurring: {
        interval: 'month',
        interval_count: 1,
        usage_type: 'licensed',
      },
    } as Stripe.Response<Stripe.Price>);
    jest.spyOn(stripe.customers, 'create').mockResolvedValue({
      id: 'cus_test',
      livemode: false,
      metadata: session.metadata,
    } as unknown as Stripe.Response<Stripe.Customer>);
    jest.spyOn(stripe.customers, 'retrieve').mockResolvedValue({
      id: 'cus_test',
      livemode: false,
      metadata: session.metadata,
    } as unknown as Stripe.Response<Stripe.Customer>);
    jest.spyOn(stripe.subscriptions, 'list').mockResolvedValue({
      data: [],
      has_more: false,
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Subscription>>);
    jest
      .spyOn(stripe.checkout.sessions, 'create')
      .mockImplementation((params) =>
        Promise.resolve({
          ...session,
          metadata: params?.metadata,
        } as unknown as Stripe.Response<Stripe.Checkout.Session>),
      );
    jest.spyOn(stripe.checkout.sessions, 'retrieve').mockImplementation(() =>
      Promise.resolve({
        ...session,
        metadata: {
          ...session.metadata,
          despensalistaCheckoutToken: record?.checkout?.token,
        },
      } as unknown as Stripe.Response<Stripe.Checkout.Session>),
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps closed live enrollment separate from existing subscriptions', async () => {
    settings.mockResolvedValue(production);
    membership.mockResolvedValue({ householdId: 'household-1', role: 'owner' });
    record = {
      householdId: 'household-1',
      revision: 1,
      customerId: 'cus_live',
      subscriptionId: 'sub_live',
      status: 'active',
    };
    await expect(
      service.checkout('owner-1', production.origin, true),
    ).rejects.toMatchObject({ status: 503 });
    expect(permissions).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    const testPrice = await stripe.prices.retrieve(billing.priceId);
    jest.mocked(stripe.prices.retrieve).mockResolvedValueOnce({
      ...testPrice,
      active: false,
      livemode: true,
      product: production.productId,
    });
    await expect(service.status('owner-1')).resolves.toMatchObject({
      mode: 'live',
      hasPlus: false,
      canCheckout: false,
      canOpenPortal: true,
    });
  });

  it('requires explicit recurring terms before opening a live Checkout', async () => {
    settings.mockResolvedValue({ ...production, checkoutEnabled: true });
    await expect(
      service.checkout('owner-1', production.origin),
    ).rejects.toMatchObject({ status: 400 });
    expect(permissions).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('does not start billing changes while the household checkout is locked', async () => {
    beginCheckout.mockResolvedValue(undefined);
    await expect(
      service.checkout('owner-1', billing.origin),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(beginCheckout).toHaveBeenCalledWith(billing.table, 'household-1');
    expect(endCheckout).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('releases the household checkout lease after a Stripe failure', async () => {
    jest
      .mocked(stripe.customers.create)
      .mockRejectedValueOnce(new Error('unavailable'));
    await expect(
      service.checkout('owner-1', billing.origin),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(endCheckout).toHaveBeenCalledWith(
      billing.table,
      'household-1',
      'lease',
    );
  });

  it('ignores a signed same-account foreign customer before reading Stripe or saving', async () => {
    settings.mockResolvedValue(production);
    const payload = JSON.stringify({
      id: 'evt_roadmap2u',
      type: 'invoice.paid',
      livemode: true,
      data: { object: { customer: 'cus_roadmap2u' } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    await expect(
      service.webhook(Buffer.from(payload), signature),
    ).resolves.toBeUndefined();
    expect(customerMapping).toHaveBeenCalledWith(
      production.table,
      'cus_roadmap2u',
    );
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not grant Plus when only the subscription status is active', async () => {
    membership.mockResolvedValue({ householdId: 'household-1', role: 'owner' });
    record = { householdId: 'household-1', revision: 1, status: 'active' };
    await expect(service.status('owner-1')).resolves.toMatchObject({
      mode: 'test',
      hasPlus: false,
    });
  });

  it('grants live Plus only after a paid invoice for the present item period', async () => {
    settings.mockResolvedValue(production);
    membership.mockResolvedValue({ householdId: 'household-1', role: 'owner' });
    customerMapping.mockResolvedValue('household-1');
    record = {
      householdId: 'household-1',
      revision: 1,
      customerId: 'cus_live',
    };
    const metadata = {
      integration: 'despensalista',
      stage: 'prod',
      despensalistaHouseholdId: 'household-1',
    };
    jest.mocked(stripe.customers.retrieve).mockResolvedValue({
      id: 'cus_live',
      livemode: true,
      metadata,
    } as unknown as Stripe.Response<Stripe.Customer>);
    const currentPeriodEnd = Math.ceil(Date.now() / 1000) + 60;
    const subscription = {
      id: 'sub_live',
      status: 'active',
      customer: 'cus_live',
      livemode: true,
      metadata,
      cancel_at_period_end: true,
      items: {
        has_more: false,
        data: [
          {
            id: 'si_live',
            quantity: 1,
            price: { id: production.priceId, product: production.productId },
            current_period_end: currentPeriodEnd,
          },
        ],
      },
      latest_invoice: {
        status: 'paid',
        amount_paid: 5900,
        currency: 'mxn',
        customer: 'cus_live',
        livemode: true,
        parent: { subscription_details: { subscription: 'sub_live' } },
        lines: {
          data: [
            {
              currency: 'mxn',
              amount: 5900,
              period: { end: currentPeriodEnd - 60 },
              parent: {
                subscription_item_details: { subscription_item: 'si_live' },
              },
              pricing: { price_details: { price: production.priceId } },
            },
          ],
        },
      },
    };
    jest.mocked(stripe.subscriptions.list).mockResolvedValue({
      data: [subscription],
      has_more: false,
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Subscription>>);
    const sendPaidEvent = async (id: string) => {
      const payload = JSON.stringify({
        id,
        type: 'invoice.paid',
        livemode: true,
        data: { object: { customer: 'cus_live' } },
      });
      await service.webhook(
        Buffer.from(payload),
        stripe.webhooks.generateTestHeaderString({
          payload,
          secret,
        }),
      );
    };
    await sendPaidEvent('evt_old_period');
    expect(record?.paidThrough).toBeUndefined();
    subscription.latest_invoice.lines.data[0].period.end = currentPeriodEnd;
    await sendPaidEvent('evt_current_period');
    expect(record?.paidThrough).toBe(currentPeriodEnd);
    const testPrice = await stripe.prices.retrieve(billing.priceId);
    jest.mocked(stripe.prices.retrieve).mockResolvedValueOnce({
      ...testPrice,
      livemode: true,
      product: production.productId,
    });
    await expect(service.status('owner-1')).resolves.toMatchObject({
      mode: 'live',
      hasPlus: true,
      canCheckout: false,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(currentPeriodEnd * 1000).toISOString(),
    });
  });

  it('reads the plan without creating a household for a new user', async () => {
    expect(await service.status('owner-1')).toEqual({
      available: true,
      mode: 'test',
      hasPlus: false,
      canManage: true,
      canCheckout: true,
      canOpenPortal: false,
      status: 'none',
      plan: {
        label: 'Plus Hogar',
        currency: 'mxn',
        interval: 'month',
        amountMinor: 5900,
      },
    });
    expect(permissions).not.toHaveBeenCalled();
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('rejects other origins and household members before billing calls', async () => {
    await expect(
      service.checkout('owner-1', 'https://other.example'),
    ).rejects.toMatchObject({ status: 403 });
    expect(permissions).not.toHaveBeenCalled();
    permissions.mockResolvedValue({
      householdId: 'household-1',
      pantryOwnerUserId: 'owner-1',
    });
    await expect(
      service.checkout('member-1', billing.origin),
    ).rejects.toMatchObject({ status: 403 });
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it('disables checkout and webhooks without sandbox configuration', async () => {
    settings.mockResolvedValue(undefined);
    expect(await service.status('owner-1')).toEqual({
      available: false,
      canManage: false,
    });
    await expect(
      service.checkout('owner-1', billing.origin),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.portal('owner-1', billing.origin),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.webhook(Buffer.from('{}'), 'unused'),
    ).rejects.toMatchObject({ status: 404 });
    expect(membership).not.toHaveBeenCalled();
    expect(stripe.prices.retrieve).not.toHaveBeenCalled();
  });

  it('only opens the hosted sandbox portal for the billed household owner', async () => {
    membership.mockResolvedValue({
      householdId: 'household-1',
      role: 'viewer',
    });
    record = {
      householdId: 'household-1',
      revision: 3,
      customerId: 'cus_test',
      subscriptionId: 'sub_test',
      status: 'active',
    };
    const createPortal = jest
      .spyOn(stripe.billingPortal.sessions, 'create')
      .mockResolvedValue({
        customer: 'cus_test',
        livemode: false,
        url: 'https://billing.stripe.com/p/session/test',
      } as Stripe.Response<Stripe.BillingPortal.Session>);
    expect(await service.status('member-1')).toMatchObject({
      status: 'active',
      canManage: false,
      canCheckout: false,
      canOpenPortal: false,
    });
    await expect(
      service.portal('member-1', billing.origin),
    ).rejects.toMatchObject({ status: 403 });
    expect(createPortal).not.toHaveBeenCalled();
    membership.mockResolvedValue({ householdId: 'household-1', role: 'owner' });
    expect(await service.portal('owner-1', billing.origin)).toEqual({
      url: 'https://billing.stripe.com/p/session/test',
    });
    expect(createPortal).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test',
        return_url: billing.origin + '/profile?billing=portal',
      }),
    );
  });

  it('reopens the same checkout and keeps the same durable customer', async () => {
    const first = await service.checkout('owner-1', billing.origin);
    expect(await service.checkout('owner-1', billing.origin)).toEqual(first);
    expect(stripe.customers.create).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test',
        line_items: [{ price: 'price_test', quantity: 1 }],
        success_url: billing.origin + '/profile?billing=success',
      }),
      { idempotencyKey: expect.any(String) },
    );
  });

  it('shares Stripe idempotency keys across simultaneous checkout requests', async () => {
    const [first, second] = await Promise.all([
      service.checkout('owner-1', billing.origin),
      service.checkout('owner-1', billing.origin),
    ]);
    expect(first).toEqual(second);
    expect(record?.checkout?.stripeSessionId).toBe(session.id);
    const customerKeys = jest
      .mocked(stripe.customers.create)
      .mock.calls.map(([, options]) => options?.idempotencyKey);
    const checkoutKeys = jest
      .mocked(stripe.checkout.sessions.create)
      .mock.calls.map(([, options]) => options?.idempotencyKey);
    expect(new Set(customerKeys)).toEqual(
      new Set(['despensalista-dev-customer:household-1']),
    );
    expect(new Set(checkoutKeys)).toEqual(
      new Set([`despensalista-dev-checkout:${record?.checkout?.token}`]),
    );
  });

  it('verifies exact webhook bytes and rejects live events', async () => {
    const payload =
      '{ "id":"evt_test", "type":"invoice.paid", "livemode":true, "data":{"object":{"customer":"cus_test"}} }';
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    await expect(
      service.webhook(Buffer.from(payload + '\n'), signature),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.webhook(Buffer.from(payload), signature),
    ).rejects.toMatchObject({ status: 400 });
    expect(exists).not.toHaveBeenCalled();
  });

  it('passes exact webhook bytes through Fastify and guards customer routes', async () => {
    const module = await Test.createTestingModule({
      controllers: [StripeBillingController],
      providers: [{ provide: StripeBillingService, useValue: service }],
    })
      .overrideGuard(AccessTokenGuard)
      .useValue({
        canActivate: () => false,
      })
      .compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { rawBody: true },
    );
    await app.init();
    try {
      const payload = Buffer.from(
        '{"id": "evt_exact", "type":"invoice.paid", "livemode":false, "data":{"object":{"customer":"cus_test", "note":"México"}}}\n',
      );
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: payload.toString('utf8'),
        secret,
      });
      const server = app.getHttpAdapter().getInstance();
      const webhook = await server.inject({
        method: 'POST',
        url: '/billing/webhook',
        payload,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
        },
      });
      expect(webhook.statusCode).toBe(204);
      expect(exists).toHaveBeenCalledWith(billing.table, 'evt_exact');
      const status = await server.inject({
        method: 'GET',
        url: '/billing/status',
      });
      expect(status.statusCode).toBe(403);
      const checkout = await server.inject({
        method: 'POST',
        url: '/billing/checkout',
      });
      expect(checkout.statusCode).toBe(403);
      const portal = await server.inject({
        method: 'POST',
        url: '/billing/portal',
      });
      expect(portal.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('reconciles the current subscription for an old event and skips its duplicate', async () => {
    await service.checkout('owner-1', billing.origin);
    jest.mocked(stripe.subscriptions.list).mockResolvedValue({
      data: [
        {
          id: 'sub_test',
          status: 'active',
          created: 20,
          livemode: false,
          metadata: session.metadata,
          latest_invoice: { status: 'paid' },
          items: { data: [{ price: { id: billing.priceId } }] },
        },
      ],
      has_more: false,
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Subscription>>);
    const payload = JSON.stringify({
      id: 'evt_older',
      type: 'customer.subscription.deleted',
      livemode: false,
      created: 10,
      data: { object: { id: 'sub_old', customer: 'cus_test' } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
    });
    await service.webhook(Buffer.from(payload), signature);
    expect(record).toMatchObject({
      status: 'active',
      subscriptionId: 'sub_test',
    });
    exists.mockResolvedValue(true);
    await service.webhook(Buffer.from(payload), signature);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('keeps asynchronous payment pending until the Stripe invoice is paid', async () => {
    await service.checkout('owner-1', billing.origin);
    const subscription = {
      id: 'sub_delayed',
      status: 'active',
      livemode: false,
      metadata: session.metadata,
      latest_invoice: { status: 'open' },
    };
    const list = jest.mocked(stripe.subscriptions.list);
    list.mockResolvedValue({
      data: [subscription],
      has_more: false,
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Subscription>>);
    const deliver = (type: string, object: object) => {
      const payload = JSON.stringify({
        id: `evt_${type.replaceAll('.', '_')}`,
        type,
        livemode: false,
        data: { object },
      });
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret,
      });
      return service.webhook(Buffer.from(payload), signature);
    };
    const checkout = {
      ...session,
      status: 'complete',
      payment_status: 'unpaid',
      metadata: {
        ...session.metadata,
        despensalistaCheckoutToken: record?.checkout?.token,
      },
    };
    await deliver('checkout.session.completed', checkout);
    expect(record?.status).toBe('pending');
    expect(record?.checkout?.stripeSessionId).toBe(session.id);
    list.mockResolvedValue({
      data: [{ ...subscription, latest_invoice: { status: 'paid' } }],
      has_more: false,
    } as unknown as Stripe.Response<Stripe.ApiList<Stripe.Subscription>>);
    await deliver('invoice.paid', { customer: 'cus_test' });
    expect(record?.status).toBe('active');
    await deliver('checkout.session.async_payment_succeeded', {
      ...checkout,
      payment_status: 'paid',
    });
    expect(record?.checkout).toBeUndefined();
    await expect(
      service.checkout('owner-1', billing.origin),
    ).rejects.toMatchObject({ status: 409 });
  });
});
