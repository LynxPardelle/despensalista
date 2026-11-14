import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Match the runtime Stripe import.
import Stripe = require('stripe');
import { StripeBillingConfig } from './stripe-billing-config';

jest.mock('stripe');

describe('StripeBillingConfig environments', () => {
  const devEnv = {
    PERSISTENCE_PROVIDER: 'dynamodb',
    STRIPE_BILLING_ORIGIN: 'https://dev.despensalista.lynxpardelle.com',
    STRIPE_BILLING_TABLE: 'despensalista-dev-billing',
    STRIPE_BILLING_CONFIG_PARAMETER: '/despensalista/dev/billing/stripe',
    COGNITO_REDIRECT_URI:
      'https://dev.despensalista.lynxpardelle.com/api/auth/cognito/callback',
  };
  const liveEnv = {
    PERSISTENCE_PROVIDER: 'dynamodb',
    STRIPE_BILLING_MODE: 'live',
    STRIPE_BILLING_ORIGIN: 'https://despensalista.com',
    STRIPE_BILLING_TABLE: 'despensalista-prod-billing',
    STRIPE_BILLING_CONFIG_PARAMETER: '/despensalista/prod/billing/stripe',
    COGNITO_SECONDARY_WEB_ORIGIN: 'https://despensalista.com',
  };
  const sandbox = {
    apiKey: 'rk_test_fake123',
    webhookSigningSecret: 'whsec_fake123',
    priceId: 'price_fake123',
  };
  const live = {
    ...sandbox,
    apiKey: 'rk_live_fake123',
    accountId: 'acct_fake123',
    productId: 'prod_fake123',
    portalConfigurationId: 'bpc_fake123',
  };
  const retrieve = jest.fn<Promise<unknown>, [null]>();
  let send: jest.SpyInstance;

  function loader(env: Record<string, string>) {
    return new StripeBillingConfig({
      get: (key: string) => env[key],
    } as ConfigService);
  }

  beforeEach(() => {
    send = jest.spyOn(SSMClient.prototype, 'send');
    retrieve.mockResolvedValue({
      id: live.accountId,
      country: 'MX',
      charges_enabled: true,
      details_submitted: true,
    });
    jest
      .mocked(Stripe)
      .mockImplementation(
        () => ({ accounts: { retrieve } }) as unknown as Stripe,
      );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function settings(value: unknown) {
    send.mockResolvedValue({
      Parameter: { Type: 'SecureString', Value: JSON.stringify(value) },
    });
  }

  it('keeps the already provisioned dev sandbox and checkout compatible', async () => {
    settings(sandbox);
    await expect(loader(devEnv).get()).resolves.toMatchObject({
      mode: 'test',
      stage: 'dev',
      checkoutEnabled: true,
    });
    expect(send).toHaveBeenCalledWith(expect.any(GetParameterCommand));
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('leaves billing absent when no environment configuration is provided', async () => {
    await expect(
      loader({ PERSISTENCE_PROVIDER: 'dynamodb' }).get(),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects partial billing configuration instead of allowing deletion to skip it', async () => {
    await expect(
      loader({
        PERSISTENCE_PROVIDER: 'dynamodb',
        STRIPE_BILLING_CONFIG_PARAMETER:
          liveEnv.STRIPE_BILLING_CONFIG_PARAMETER,
      }).get(),
    ).rejects.toMatchObject({ status: 503 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects prod config without live mode or from a mismatched origin', async () => {
    await expect(
      loader({ ...liveEnv, STRIPE_BILLING_MODE: 'test' }).get(),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      loader({
        ...liveEnv,
        COGNITO_SECONDARY_WEB_ORIGIN: 'https://other.example',
      }).get(),
    ).rejects.toMatchObject({ status: 503 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects test credentials and live settings for another account', async () => {
    settings({ ...live, apiKey: sandbox.apiKey });
    await expect(loader(liveEnv).get()).rejects.toMatchObject({ status: 503 });
    expect(retrieve).not.toHaveBeenCalled();
    settings(live);
    retrieve.mockResolvedValue({ id: 'acct_other', country: 'MX' });
    await expect(loader(liveEnv).get()).rejects.toMatchObject({ status: 503 });
  });

  it('loads dedicated live settings with purchases closed by default', async () => {
    settings(live);
    await expect(loader(liveEnv).get()).resolves.toMatchObject({
      mode: 'live',
      stage: 'prod',
      checkoutEnabled: false,
      accountId: live.accountId,
      productId: live.productId,
      portalConfigurationId: live.portalConfigurationId,
    });
    expect(retrieve).toHaveBeenCalledWith(null);
    expect(send.mock.calls[0][0].input).toEqual({
      Name: '/despensalista/prod/billing/stripe',
      WithDecryption: true,
    });
  });
});
