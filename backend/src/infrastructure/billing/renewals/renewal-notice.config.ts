import type { ConfigService } from '@nestjs/config';

export const renewalNoticeDevTable = 'despensalista-dev-renewal-notices';
export const renewalNoticeProdTable = 'despensalista-prod-renewal-notices';
export const sesSuccessSimulator = 'success@simulator.amazonses.com';

export type RenewalNoticeSettings =
  | ({ stage: 'dev'; table: typeof renewalNoticeDevTable } & (
      | { mode: 'dry-run'; testRecipient?: undefined }
      | { mode: 'ses'; testRecipient: string }
    ))
  | {
      stage: 'prod';
      table: typeof renewalNoticeProdTable;
      mode: 'dry-run' | 'ses';
      testRecipient?: undefined;
    };

export function isRenewalRecipient(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function renewalNoticeConfig(
  config: ConfigService,
): RenewalNoticeSettings | undefined {
  const mode = config.get<string>('RENEWAL_NOTICE_MODE');
  if (mode !== 'dry-run' && mode !== 'ses') return undefined;
  const stage = config.get<string>('RENEWAL_NOTICE_STAGE');
  const table = config.get<string>('RENEWAL_NOTICE_TABLE');
  const billing = config.get<string>('STRIPE_BILLING_MODE');
  const testRecipient = config
    .get<string>('RENEWAL_NOTICE_SES_TEST_TO')
    ?.trim()
    .toLowerCase();

  if (
    stage === 'prod' &&
    table === renewalNoticeProdTable &&
    billing === 'live' &&
    !testRecipient
  ) {
    return { stage, table, mode };
  }
  if (
    (stage !== undefined && stage !== 'dev') ||
    table !== renewalNoticeDevTable ||
    billing !== 'test'
  ) {
    return undefined;
  }
  if (mode === 'dry-run') return { stage: 'dev', table, mode };

  if (testRecipient && isRenewalRecipient(testRecipient)) {
    return { stage: 'dev', table, mode, testRecipient };
  }
  return undefined;
}
