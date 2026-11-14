import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- The Stripe CommonJS package exports its constructor directly.
import Stripe = require('stripe');

const devOrigin = 'https://dev.despensalista.lynxpardelle.com';
const devTable = 'despensalista-dev-billing';
const devParameter = '/despensalista/dev/billing/stripe';
const productionOrigin = 'https://despensalista.com';
const productionTable = 'despensalista-prod-billing';
const productionParameter = '/despensalista/prod/billing/stripe';

export interface StripeBillingSettings {
  mode: 'test' | 'live';
  stage: 'dev' | 'prod';
  checkoutEnabled: boolean;
  origin: string;
  table: string;
  accountId?: string;
  productId?: string;
  priceId: string;
  webhookSigningSecret: string;
  portalConfigurationId?: string;
  stripe: Stripe;
}

@Injectable()
export class StripeBillingConfig {
  private readonly ssm = new SSMClient({});
  private cached?: {
    expiresAt: number;
    settings: Promise<StripeBillingSettings>;
  };

  constructor(private readonly config: ConfigService) {}

  async get(): Promise<StripeBillingSettings | undefined> {
    const mode = this.config.get<string>('STRIPE_BILLING_MODE') ?? 'test';
    const checkoutFlag = this.config.get<string>(
      'STRIPE_BILLING_CHECKOUT_ENABLED',
    );
    const origin = this.config.get<string>('STRIPE_BILLING_ORIGIN');
    const table = this.config.get<string>('STRIPE_BILLING_TABLE');
    const parameter = this.config.get<string>(
      'STRIPE_BILLING_CONFIG_PARAMETER',
    );
    const isDev =
      mode === 'test' &&
      origin === devOrigin &&
      table === devTable &&
      parameter === devParameter &&
      this.config.get('COGNITO_REDIRECT_URI') ===
        `${devOrigin}/api/auth/cognito/callback`;
    const isProduction =
      mode === 'live' &&
      origin === productionOrigin &&
      table === productionTable &&
      parameter === productionParameter &&
      this.config.get('COGNITO_SECONDARY_WEB_ORIGIN') === productionOrigin;
    if (
      this.config.get('PERSISTENCE_PROVIDER') !== 'dynamodb' ||
      (!isDev && !isProduction) ||
      (checkoutFlag !== undefined && !['true', 'false'].includes(checkoutFlag))
    ) {
      return undefined;
    }

    if (!this.cached || this.cached.expiresAt <= Date.now()) {
      const settings = this.load(
        {
          mode,
          stage: isProduction ? 'prod' : 'dev',
          origin,
          table,
          checkoutEnabled:
            checkoutFlag === 'true' || (checkoutFlag === undefined && isDev),
        },
        parameter,
      );
      this.cached = { settings, expiresAt: Date.now() + 60_000 };
    }
    const current = this.cached;
    try {
      return await current.settings;
    } catch {
      if (this.cached === current) {
        this.cached = undefined;
      }
      throw new ServiceUnavailableException('Billing is unavailable');
    }
  }

  private async load(
    base: Pick<
      StripeBillingSettings,
      'mode' | 'stage' | 'origin' | 'table' | 'checkoutEnabled'
    >,
    parameter: string,
  ): Promise<StripeBillingSettings> {
    const result = await this.ssm.send(
      new GetParameterCommand({ Name: parameter, WithDecryption: true }),
    );
    if (result.Parameter?.Type !== 'SecureString') {
      throw new Error('Expected encrypted billing settings');
    }
    const raw: unknown = JSON.parse(result.Parameter.Value ?? '');
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('apiKey' in raw) ||
      !isStripeIdentifier(
        raw.apiKey,
        base.mode === 'live'
          ? /^rk_live_[a-zA-Z0-9]+$/
          : /^(sk|rk|rkcs)_test_[a-zA-Z0-9]+$/,
      ) ||
      !('webhookSigningSecret' in raw) ||
      !isStripeIdentifier(raw.webhookSigningSecret, /^whsec_[a-zA-Z0-9]+$/) ||
      !('priceId' in raw) ||
      !isStripeIdentifier(raw.priceId, /^price_[a-zA-Z0-9]+$/)
    ) {
      throw new Error('Invalid billing settings');
    }
    const portalConfigurationId =
      'portalConfigurationId' in raw ? raw.portalConfigurationId : undefined;
    if (
      portalConfigurationId !== undefined &&
      !isStripeIdentifier(portalConfigurationId, /^bpc_[a-zA-Z0-9]+$/)
    ) {
      throw new Error('Invalid billing portal settings');
    }
    const accountId = 'accountId' in raw ? raw.accountId : undefined;
    const productId = 'productId' in raw ? raw.productId : undefined;
    const stripe = new Stripe(raw.apiKey, {
      timeout: 5_000,
      maxNetworkRetries: 1,
    });
    let checkoutEnabled = base.checkoutEnabled;
    if (base.mode === 'live') {
      if (
        !isStripeIdentifier(accountId, /^acct_[a-zA-Z0-9]+$/) ||
        !isStripeIdentifier(productId, /^prod_[a-zA-Z0-9]+$/) ||
        !portalConfigurationId
      ) {
        throw new Error('Live billing requires an account, product and portal');
      }
      const account = await stripe.accounts.retrieve(null);
      if (account.id !== accountId || account.country !== 'MX') {
        throw new Error('Unexpected Stripe account');
      }
      checkoutEnabled =
        checkoutEnabled &&
        account.charges_enabled &&
        account.details_submitted &&
        !account.requirements?.currently_due?.length;
    }
    return {
      ...base,
      checkoutEnabled,
      accountId: typeof accountId === 'string' ? accountId : undefined,
      productId: typeof productId === 'string' ? productId : undefined,
      priceId: raw.priceId,
      webhookSigningSecret: raw.webhookSigningSecret,
      portalConfigurationId,
      stripe,
    };
  }
}

function isStripeIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
