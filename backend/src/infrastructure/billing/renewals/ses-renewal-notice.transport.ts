import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RenewalNoticeMessage,
  RenewalNoticeTransport,
} from './renewal-notice.types';

const sender = 'no-reply@despensalista.lynxpardelle.com';

@Injectable()
export class SesRenewalNoticeTransport implements RenewalNoticeTransport {
  private readonly ses = new SESv2Client({
    region: 'us-east-1',
    maxAttempts: 1,
  });

  constructor(private readonly config: ConfigService) {}

  async send(message: RenewalNoticeMessage): Promise<{ messageId: string }> {
    if (
      this.config.get('STRIPE_BILLING_MODE') !== 'test' ||
      this.config.get('RENEWAL_NOTICE_MODE') !== 'ses' ||
      this.config.get('RENEWAL_NOTICE_TABLE') !==
        'despensalista-dev-renewal-notices' ||
      this.config.get('RENEWAL_NOTICE_SES_TEST_TO') !== message.recipient
    ) {
      throw new Error('Renewal notice transport is unavailable');
    }

    const sent = await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: sender,
        Destination: { ToAddresses: [message.recipient] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    if (!sent.MessageId) throw new Error('SES did not return a message ID');
    return { messageId: sent.MessageId };
  }
}
