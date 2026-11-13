import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- The Stripe CommonJS package exports its constructor directly.
import Stripe = require('stripe');

const devOrigin = 'https://dev.despensalista.lynxpardelle.com';
const devTable = 'despensalista-dev-billing';
const devParameter = '/despensalista/dev/billing/stripe';

export interface StripeBillingSettings {
  origin: string;
  table: string;
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
    if (
      this.config.get('PERSISTENCE_PROVIDER') !== 'dynamodb' ||
      this.config.get('STRIPE_BILLING_ORIGIN') !== devOrigin ||
      this.config.get('STRIPE_BILLING_TABLE') !== devTable ||
      this.config.get('STRIPE_BILLING_CONFIG_PARAMETER') !== devParameter ||
      this.config.get('COGNITO_REDIRECT_URI') !==
        `${devOrigin}/api/auth/cognito/callback`
    ) {
      return undefined;
    }

    if (!this.cached || this.cached.expiresAt <= Date.now()) {
      const settings = this.load();
      this.cached = { settings, expiresAt: Date.now() + 60_000 };
    }
    const current = this.cached;
    try {
      return await current.settings;
    } catch {
      if (this.cached === current) {
        this.cached = undefined;
      }
      throw new ServiceUnavailableException('Sandbox billing is unavailable');
    }
  }

  private async load(): Promise<StripeBillingSettings> {
    const result = await this.ssm.send(
      new GetParameterCommand({ Name: devParameter, WithDecryption: true }),
    );
    if (result.Parameter?.Type !== 'SecureString') {
      throw new Error('Expected encrypted sandbox billing settings');
    }
    const raw: unknown = JSON.parse(result.Parameter.Value ?? '');
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('apiKey' in raw) ||
      !isStripeIdentifier(raw.apiKey, /^(sk|rk|rkcs)_test_[a-zA-Z0-9]+$/) ||
      !('webhookSigningSecret' in raw) ||
      !isStripeIdentifier(raw.webhookSigningSecret, /^whsec_[a-zA-Z0-9]+$/) ||
      !('priceId' in raw) ||
      !isStripeIdentifier(raw.priceId, /^price_[a-zA-Z0-9]+$/)
    ) {
      throw new Error('Invalid sandbox billing settings');
    }
    const portalConfigurationId =
      'portalConfigurationId' in raw ? raw.portalConfigurationId : undefined;
    if (
      portalConfigurationId !== undefined &&
      !isStripeIdentifier(portalConfigurationId, /^bpc_[a-zA-Z0-9]+$/)
    ) {
      throw new Error('Invalid sandbox billing portal settings');
    }
    return {
      origin: devOrigin,
      table: devTable,
      priceId: raw.priceId,
      webhookSigningSecret: raw.webhookSigningSecret,
      portalConfigurationId,
      stripe: new Stripe(raw.apiKey, { timeout: 5_000, maxNetworkRetries: 1 }),
    };
  }
}

function isStripeIdentifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}
