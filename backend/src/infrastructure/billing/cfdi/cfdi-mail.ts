import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CfdiInvoice } from './cfdi-invoice';
import { type CfdiFiscalData, validContactAddress } from './cfdi-request';

type CfdiMailOptions = {
  sender: string;
  recipient: string;
  stage: 'dev' | 'prod';
};

const mxn = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
});
const definitivelyRejected = new Set([400, 401, 403, 404, 429]);

@Injectable()
export class CfdiMail {
  private readonly ses = new SESv2Client({
    region: 'us-east-1',
    maxAttempts: 1,
  });

  constructor(private readonly config: ConfigService) {}

  options(): CfdiMailOptions | undefined {
    if (this.config.get('CFDI_REQUEST_MODE') !== 'ses') return undefined;
    const stage = this.config.get<string>('CFDI_REQUEST_STAGE');
    const sender = this.config.get<string>('CFDI_REQUEST_FROM');
    const recipient = this.config.get<string>('CFDI_REQUEST_RECIPIENT');
    if (
      (stage !== 'dev' && stage !== 'prod') ||
      !sender ||
      !validContactAddress(sender) ||
      !recipient ||
      !validContactAddress(recipient)
    ) {
      return undefined;
    }
    return { stage, sender, recipient };
  }

  async request(
    options: CfdiMailOptions,
    id: string,
    payment: CfdiInvoice,
    fiscal: CfdiFiscalData,
  ) {
    const testPrefix = options.stage === 'dev' ? '[Prueba] ' : '';
    const text = [
      ...(testPrefix
        ? ['Prueba de Stripe Sandbox. No emitas un CFDI por este pago de prueba.']
        : []),
      'Solicitaron un CFDI por un pago de Plus Hogar. ZooBeriah Systems emite el comprobante.',
      '',
      `Folio de solicitud: ${id}`,
      `Pago en Stripe: ${payment.id}`,
      `Fecha de pago (UTC): ${payment.paidAt}`,
      `Subtotal: ${mxn.format(payment.subtotalMinor / 100)} MXN`,
      `Impuesto en Stripe: ${mxn.format(payment.taxMinor / 100)} MXN`,
      `Total pagado: ${mxn.format(payment.amountMinor / 100)} MXN`,
      '',
      `RFC: ${fiscal.rfc}`,
      `Nombre o razón social: ${fiscal.legalName}`,
      `Código postal fiscal: ${fiscal.postalCode}`,
      `Régimen fiscal: ${fiscal.taxRegime}`,
      `Uso del CFDI: ${fiscal.cfdiUse}`,
      ...(fiscal.email
        ? [`Correo para entrega: ${fiscal.email}`]
        : [
            'La persona solicitante omitió el correo de entrega. Conserva el folio para coordinar la entrega si se comunica al buzón de facturas.',
          ]),
      '',
      'Consulta el pago en Stripe para confirmar su forma de pago y cualquier reembolso antes de emitir o corregir el CFDI.',
    ].join('\n');

    try {
      const result = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: options.sender,
          Destination: { ToAddresses: [options.recipient] },
          Content: {
            Simple: {
              Subject: {
                Data: `${testPrefix}DespensaLista · Solicitud de CFDI ${id}`,
                Charset: 'UTF-8',
              },
              Body: { Text: { Data: text, Charset: 'UTF-8' } },
            },
          },
        }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
      return result.MessageId
        ? { status: 'sent' as const, messageId: result.MessageId }
        : { status: 'delivery_unknown' as const };
    } catch (error) {
      const code = (error as { $metadata?: { httpStatusCode?: number } } | null)
        ?.$metadata?.httpStatusCode;
      return code !== undefined && definitivelyRejected.has(code)
        ? { status: 'pending' as const }
        : { status: 'delivery_unknown' as const };
    }
  }
}
