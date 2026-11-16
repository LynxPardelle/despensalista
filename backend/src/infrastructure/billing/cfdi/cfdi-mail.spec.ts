import { SESv2Client, type SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';
import { CfdiMail } from './cfdi-mail';

const invoice = {
  id: 'in_Fixture',
  paidAt: '2026-11-15T18:53:22.000Z',
  amountMinor: 6844,
  currency: 'mxn' as const,
  subtotalMinor: 5900,
  taxMinor: 944,
};

const fiscalData = {
  rfc: 'XAXX010101000',
  legalName: 'Solicitud de prueba',
  postalCode: '01234',
  taxRegime: '616',
  cfdiUse: 'S01',
};

const mail = new CfdiMail(
  new ConfigService({
    CFDI_REQUEST_MODE: 'ses',
    CFDI_REQUEST_STAGE: 'dev',
    CFDI_REQUEST_FROM: 'sender@example.com',
    CFDI_REQUEST_RECIPIENT: 'billing@example.com',
  }),
);

afterEach(() => jest.restoreAllMocks());

it('sends paid amounts and tax details only to the configured inbox', async () => {
  const send = jest
    .spyOn(SESv2Client.prototype, 'send')
    .mockResolvedValue({ MessageId: 'receipt' } as never);
  await expect(
    mail.request(mail.options()!, 'folio', invoice, {
      ...fiscalData,
      accountEmail: 'account@example.com',
      additionalEmail: 'delivery@example.com',
    }),
  ).resolves.toEqual({ status: 'sent', messageId: 'receipt' });
  const command = send.mock.calls[0][0] as SendEmailCommand;
  expect(command.input).toMatchObject({
    FromEmailAddress: 'sender@example.com',
    Destination: { ToAddresses: ['billing@example.com'] },
  });
  expect(command.input.ReplyToAddresses).toBeUndefined();
  const simple = command.input.Content?.Simple;
  expect(simple?.Subject?.Data).toContain('[Prueba]');
  expect(simple?.Subject?.Data).not.toContain(fiscalData.rfc);
  expect(simple?.Body?.Text?.Data).toContain('Total pagado: $68.44 MXN');
  expect(simple?.Body?.Text?.Data).toContain(
    'Correo principal de la cuenta: account@example.com',
  );
  expect(simple?.Body?.Text?.Data).toContain(
    'Correo adicional: delivery@example.com',
  );
});

it('includes the folio contact fallback when both addresses are absent', async () => {
  const send = jest
    .spyOn(SESv2Client.prototype, 'send')
    .mockResolvedValue({ MessageId: 'receipt' } as never);
  await mail.request(mail.options()!, 'folio', invoice, fiscalData);
  const command = send.mock.calls[0][0] as SendEmailCommand;
  const text = command.input.Content?.Simple?.Body?.Text?.Data;
  expect(text).toContain('Conserva el folio para coordinar la entrega');
  expect(text).not.toContain('Correo principal de la cuenta');
  expect(text).not.toContain('Correo adicional');
});

it.each([
  [403, 'pending'],
  [429, 'pending'],
  [503, 'delivery_unknown'],
  [undefined, 'delivery_unknown'],
])(
  'reports whether SES definitely rejected the attempt (%s)',
  async (status, expected) => {
    jest
      .spyOn(SESv2Client.prototype, 'send')
      .mockRejectedValue({ $metadata: { httpStatusCode: status } } as never);
    await expect(
      mail.request(mail.options()!, 'folio', invoice, fiscalData),
    ).resolves.toEqual({ status: expected });
  },
);
