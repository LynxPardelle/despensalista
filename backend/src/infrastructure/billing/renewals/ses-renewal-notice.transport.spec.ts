import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SesRenewalNoticeTransport } from './ses-renewal-notice.transport';

describe('SES renewal notice diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['AccessDeniedException', 'AccessDeniedException'],
    ['address@example.com', 'UnexpectedError'],
  ])('logs only safe error metadata for %s', async (name, label) => {
    const recipient = 'mailbox@example.com';
    const config = new ConfigService({
      STRIPE_BILLING_MODE: 'test',
      RENEWAL_NOTICE_MODE: 'ses',
      RENEWAL_NOTICE_TABLE: 'despensalista-dev-renewal-notices',
      RENEWAL_NOTICE_SES_TEST_TO: recipient,
    });
    const transport = new SesRenewalNoticeTransport(config);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const error = Object.assign(new Error(`Mail for ${recipient}`), {
      name,
      $metadata: { httpStatusCode: 403, requestId: recipient },
    });
    jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockRejectedValueOnce(error as never);

    await expect(
      transport.send({
        noticeId: 'test',
        recipient,
        subject: 'Test',
        text: 'Test',
      }),
    ).rejects.toBe(error);
    expect(warn.mock.calls).toEqual([
      [`SES SendEmail failed: ${label} (HTTP 403)`],
    ]);
  });
});
