import {
  GetAccountCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SesRenewalNoticeTransport } from './ses-renewal-notice.transport';

describe('SES renewal notice diagnostics', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('requires sending and production SES access before dispatching live notices', async () => {
    const transport = new SesRenewalNoticeTransport(
      new ConfigService({
        STRIPE_BILLING_MODE: 'live',
        RENEWAL_NOTICE_STAGE: 'prod',
        RENEWAL_NOTICE_MODE: 'ses',
        RENEWAL_NOTICE_TABLE: 'despensalista-prod-renewal-notices',
      }),
    );
    const ses = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockResolvedValueOnce({
        ProductionAccessEnabled: false,
        SendingEnabled: true,
      } as never)
      .mockResolvedValueOnce({
        ProductionAccessEnabled: true,
        SendingEnabled: false,
      } as never)
      .mockResolvedValueOnce({
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        SendQuota: {
          Max24HourSend: 10,
          SentLast24Hours: 8,
          MaxSendRate: 2,
        },
      } as never);
    await expect(transport.assertProductionAccess()).rejects.toThrow(
      'SES production sending is unavailable',
    );
    await expect(transport.assertProductionAccess()).rejects.toThrow(
      'SES production sending is unavailable',
    );
    await expect(transport.assertProductionAccess()).resolves.toEqual({
      maxSends: 2,
      intervalMs: 500,
    });

    expect(ses.mock.calls.map(([command]) => command)).toEqual(
      Array(3).fill(expect.any(GetAccountCommand)),
    );
  });

  it('checks a live sender only once before one ordinary delivery and blocks simulator addresses', async () => {
    const transport = new SesRenewalNoticeTransport(
      new ConfigService({
        STRIPE_BILLING_MODE: 'live',
        RENEWAL_NOTICE_STAGE: 'prod',
        RENEWAL_NOTICE_MODE: 'ses',
        RENEWAL_NOTICE_TABLE: 'despensalista-prod-renewal-notices',
      }),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const ses = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockResolvedValueOnce({
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        SendQuota: {
          Max24HourSend: 10,
          SentLast24Hours: 9,
          MaxSendRate: 1,
        },
      } as never)
      .mockResolvedValueOnce({ MessageId: 'ses-id' } as never);
    const message = {
      noticeId: 'notice',
      recipient: 'owner@example.com',
      subject: 'Subject',
      text: 'Text',
    };

    await expect(transport.send(message)).rejects.toThrow(
      'transport is unavailable',
    );
    await transport.assertProductionAccess();
    await expect(
      transport.send({
        ...message,
        recipient: 'success@simulator.amazonses.com',
      }),
    ).rejects.toThrow('transport is unavailable');
    await expect(transport.send(message)).resolves.toEqual({
      messageId: 'ses-id',
    });
    await expect(transport.send(message)).rejects.toThrow(
      'transport is unavailable',
    );

    expect(ses.mock.calls.map(([command]) => command)).toEqual([
      expect.any(GetAccountCommand),
      expect.objectContaining({
        input: expect.objectContaining({
          Destination: { ToAddresses: ['owner@example.com'] },
        }),
      }),
    ]);
    expect(ses.mock.calls[1][0]).toBeInstanceOf(SendEmailCommand);
  });

  it('enforces the production rate, keeps multiple sends, and stops on an ambiguous response', async () => {
    const transport = new SesRenewalNoticeTransport(
      new ConfigService({
        STRIPE_BILLING_MODE: 'live',
        RENEWAL_NOTICE_STAGE: 'prod',
        RENEWAL_NOTICE_MODE: 'ses',
        RENEWAL_NOTICE_TABLE: 'despensalista-prod-renewal-notices',
      }),
    );
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const ses = jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockResolvedValueOnce({
        ProductionAccessEnabled: true,
        SendingEnabled: true,
        SendQuota: { Max24HourSend: -1, SentLast24Hours: 12, MaxSendRate: 2 },
      } as never)
      .mockResolvedValueOnce({ MessageId: 'first-id' } as never)
      .mockResolvedValueOnce({ MessageId: 'second-id' } as never)
      .mockResolvedValueOnce({} as never);
    const message = {
      noticeId: 'notice',
      recipient: 'owner@example.com',
      subject: 'Subject',
      text: 'Text',
    };

    await expect(transport.assertProductionAccess()).resolves.toEqual({
      maxSends: 5,
      intervalMs: 500,
    });
    await expect(transport.send(message)).resolves.toEqual({
      messageId: 'first-id',
    });
    await jest.advanceTimersByTimeAsync(499);
    await expect(transport.send(message)).rejects.toThrow(
      'transport is unavailable',
    );
    await jest.advanceTimersByTimeAsync(1);
    await expect(transport.send(message)).resolves.toEqual({
      messageId: 'second-id',
    });
    await jest.advanceTimersByTimeAsync(500);
    await expect(transport.send(message)).rejects.toThrow(
      'SES did not return a message ID',
    );
    await jest.advanceTimersByTimeAsync(500);
    await expect(transport.send(message)).rejects.toThrow(
      'transport is unavailable',
    );
    expect(ses).toHaveBeenCalledTimes(4);
    expect(ses.mock.calls[1][1]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
    });
  });

  it.each([
    [
      'AccessDeniedException',
      'AccessDeniedException',
      'no-reply@despensalista.lynxpardelle.com',
      ' sender identity',
    ],
    [
      'AccessDenied',
      'AccessDenied',
      'despensalista.lynxpardelle.com',
      ' domain identity',
    ],
    ['address@example.com', 'UnexpectedError', 'address@example.com', ''],
  ])(
    'logs only safe error metadata for %s',
    async (name, label, identity, hint) => {
      const recipient = 'mailbox@example.com';
      const config = new ConfigService({
        STRIPE_BILLING_MODE: 'test',
        RENEWAL_NOTICE_MODE: 'ses',
        RENEWAL_NOTICE_TABLE: 'despensalista-dev-renewal-notices',
        RENEWAL_NOTICE_SES_TEST_TO: recipient,
      });
      const transport = new SesRenewalNoticeTransport(config);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const error = Object.assign(
        new Error(
          `Mail for ${recipient} on resource: arn:aws:ses:us-east-1:123456789012:identity/${identity} denied`,
        ),
        {
          name,
          $metadata: { httpStatusCode: 403, requestId: recipient },
        },
      );
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
        [`SES SendEmail failed: ${label}${hint} (HTTP 403)`],
      ]);
    },
  );
});
