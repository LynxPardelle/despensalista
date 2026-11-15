import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  RenewalNoticeMessage,
  RenewalNoticeTransport,
} from './renewal-notice.types';

const senderDomain = 'despensalista.lynxpardelle.com';
const sender = `no-reply@${senderDomain}`;
const knownErrors = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'BadRequestException',
  'CredentialsProviderError',
  'EndpointError',
  'InternalServiceErrorException',
  'MailFromDomainNotVerifiedException',
  'MessageRejected',
  'NotFoundException',
  'SendingPausedException',
  'TimeoutError',
  'TooManyRequestsException',
]);

@Injectable()
export class SesRenewalNoticeTransport implements RenewalNoticeTransport {
  private readonly logger = new Logger(SesRenewalNoticeTransport.name);
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
      this.logger.warn('SES SendEmail blocked by the dev configuration guard');
      throw new Error('Renewal notice transport is unavailable');
    }

    const sent = await this.ses
      .send(
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
      )
      .catch((error: unknown) => {
        const info = error as {
          name?: unknown;
          message?: unknown;
          $metadata?: { httpStatusCode?: unknown };
        } | null;
        const name = info?.name;
        const status = info?.$metadata?.httpStatusCode;
        const label =
          typeof name === 'string' && knownErrors.has(name)
            ? name
            : 'UnexpectedError';
        const http =
          typeof status === 'number' &&
          Number.isInteger(status) &&
          status >= 100 &&
          status < 600
            ? ` (HTTP ${status})`
            : '';
        let identityHint = '';
        if (
          (label === 'AccessDeniedException' || label === 'AccessDenied') &&
          typeof info?.message === 'string'
        ) {
          const identity =
            /arn:aws:ses:us-east-1:\d{12}:identity\/([a-z0-9@._-]+)/i.exec(
              info.message,
            )?.[1];
          if (identity === sender) identityHint = ' sender identity';
          if (identity === senderDomain) identityHint = ' domain identity';
        }
        this.logger.warn(
          `SES SendEmail failed: ${label}${identityHint}${http}`,
        );
        throw error;
      });
    if (!sent.MessageId) {
      this.logger.warn('SES SendEmail returned no message ID');
      throw new Error('SES did not return a message ID');
    }
    return { messageId: sent.MessageId };
  }
}
