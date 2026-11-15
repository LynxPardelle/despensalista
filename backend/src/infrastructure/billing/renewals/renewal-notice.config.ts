import type { ConfigService } from '@nestjs/config';

export const renewalNoticeDevTable = 'despensalista-dev-renewal-notices';
export const sesSuccessSimulator = 'success@simulator.amazonses.com';

export type RenewalNoticeSettings = {
  table: typeof renewalNoticeDevTable;
} & (
  | { mode: 'dry-run'; testRecipient?: undefined }
  | { mode: 'ses'; testRecipient: string }
);

export function renewalNoticeConfig(
  config: ConfigService,
): RenewalNoticeSettings | undefined {
  const mode = config.get<string>('RENEWAL_NOTICE_MODE');
  if (
    config.get<string>('RENEWAL_NOTICE_TABLE') !== renewalNoticeDevTable ||
    config.get<string>('STRIPE_BILLING_MODE') !== 'test'
  ) {
    return undefined;
  }
  if (mode === 'dry-run') return { table: renewalNoticeDevTable, mode };

  const testRecipient = config
    .get<string>('RENEWAL_NOTICE_SES_TEST_TO')
    ?.trim()
    .toLowerCase();
  if (
    mode === 'ses' &&
    testRecipient &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testRecipient)
  ) {
    return { table: renewalNoticeDevTable, mode, testRecipient };
  }
  return undefined;
}
