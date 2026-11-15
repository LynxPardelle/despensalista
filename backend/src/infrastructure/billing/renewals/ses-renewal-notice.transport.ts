import {
  GetAccountCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isRenewalRecipient,
  renewalNoticeConfig,
} from './renewal-notice.config';
import type {
  RenewalNoticeMessage,
  RenewalNoticeProductionAllowance,
  RenewalNoticeTransport,
} from './renewal-notice.types';

const senderDomain = 'despensalista.lynxpardelle.com';
const sender = `no-reply@${senderDomain}`;
const productionAccessWindowMs = 15_000;
const productionBatchLimit = 5;
const productionSendTimeoutMs = 2_000;
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
  private productionAccess:
    | {
        until: number;
        remaining: number;
        intervalMs: number;
        nextSendAt: number;
      }
    | undefined;
  private readonly ses = new SESv2Client({
    region: 'us-east-1',
    maxAttempts: 1,
  });

  constructor(private readonly config: ConfigService) {}

  async assertProductionAccess(): Promise<RenewalNoticeProductionAllowance> {
    const settings = renewalNoticeConfig(this.config);
    this.productionAccess = undefined;
    if (settings?.stage !== 'prod' || settings.mode !== 'ses') {
      throw new Error('SES production sending is unavailable');
    }
    const account = await this.ses
      .send(new GetAccountCommand({}), {
        abortSignal: AbortSignal.timeout(2_000),
      })
      .catch(() => {
        throw new Error('SES production sending is unavailable');
      });
    if (
      account.ProductionAccessEnabled !== true ||
      account.SendingEnabled !== true
    ) {
      throw new Error('SES production sending is unavailable');
    }
    const {
      Max24HourSend: daily,
      SentLast24Hours: sent,
      MaxSendRate: rate,
    } = account.SendQuota ?? {};
    if (
      typeof daily !== 'number' ||
      !Number.isFinite(daily) ||
      (daily < 0 && daily !== -1) ||
      typeof sent !== 'number' ||
      !Number.isFinite(sent) ||
      sent < 0 ||
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      throw new Error('SES production sending quota is unavailable');
    }
    const intervalMs = Math.ceil(1_000 / rate);
    if (!Number.isSafeInteger(intervalMs)) {
      throw new Error('SES production sending quota is unavailable');
    }
    const maxSends =
      daily === -1
        ? productionBatchLimit
        : Math.min(productionBatchLimit, Math.max(0, Math.floor(daily - sent)));
    // Refresh account access and limits once for each nonempty scheduled poll.
    const now = performance.now();
    this.productionAccess = {
      until: now + productionAccessWindowMs,
      remaining: maxSends,
      intervalMs,
      nextSendAt: now,
    };
    return { maxSends, intervalMs };
  }

  async send(message: RenewalNoticeMessage): Promise<{ messageId: string }> {
    const settings = renewalNoticeConfig(this.config);
    const access = this.productionAccess;
    const now = performance.now();
    if (
      settings?.mode !== 'ses' ||
      (settings.stage === 'dev' &&
        settings.testRecipient !== message.recipient) ||
      (settings.stage === 'prod' &&
        (!access ||
          now >= access.until ||
          now < access.nextSendAt ||
          access.remaining <= 0 ||
          !isRenewalRecipient(message.recipient) ||
          message.recipient.toLowerCase().endsWith('@simulator.amazonses.com')))
    ) {
      this.logger.warn(
        'SES SendEmail blocked by the renewal configuration guard',
      );
      throw new Error('Renewal notice transport is unavailable');
    }
    if (settings.stage === 'prod' && access) {
      access.remaining--;
      access.nextSendAt = now + access.intervalMs;
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
        settings.stage === 'prod'
          ? { abortSignal: AbortSignal.timeout(productionSendTimeoutMs) }
          : undefined,
      )
      .catch((error: unknown) => {
        if (settings.stage === 'prod') this.productionAccess = undefined;
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
      if (settings.stage === 'prod') this.productionAccess = undefined;
      this.logger.warn('SES SendEmail returned no message ID');
      throw new Error('SES did not return a message ID');
    }
    return { messageId: sent.MessageId };
  }
}
