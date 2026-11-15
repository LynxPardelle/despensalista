import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HOUSEHOLD_REPOSITORY } from '../../../application/tokens';
import type { HouseholdRepository } from '../../../domain/repositories/household.repository';
import { StripeBillingConfig } from '../stripe-billing-config';
import { StripeBillingStore } from '../stripe-billing.store';
import { cfdiInvoice, stripeInvoiceId } from './cfdi-invoice';
import { CfdiMail } from './cfdi-mail';
import { CfdiRequestStore, cfdiReceipt } from './cfdi-request.store';
import { readCfdiRequest } from './cfdi-request';

@Injectable()
export class CfdiService {
  private readonly logger = new Logger(CfdiService.name);

  constructor(
    private readonly stripeConfig: StripeBillingConfig,
    private readonly billing: StripeBillingStore,
    @Inject(HOUSEHOLD_REPOSITORY)
    private readonly households: HouseholdRepository,
    private readonly requests: CfdiRequestStore,
    private readonly mail: CfdiMail,
  ) {}

  async invoices(userId: string, cursor: unknown) {
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' || !stripeInvoiceId.test(cursor))
    ) {
      throw new BadRequestException('No se reconoce la página solicitada.');
    }
    const context = await this.context(userId);
    if (!context) return { available: false, invoices: [] };
    const { settings, owner } = context;
    const page = await this.fromStripe(() =>
      settings.stripe.invoices.list({
        customer: owner.customerId,
        status: 'paid',
        limit: 20,
        expand: ['data.payments'],
        ...(typeof cursor === 'string' && { starting_after: cursor }),
      }),
    );
    const invoices = await Promise.all(
      page.data.flatMap((invoice) => {
        const eligible = cfdiInvoice(invoice, settings, owner);
        return eligible
          ? [this.invoiceSummary(eligible, settings.table, owner.householdId)]
          : [];
      }),
    );
    // Advance from the raw page even when it only contains ineligible invoices.
    const nextCursor = page.has_more ? page.data.at(-1)?.id : undefined;
    return { available: true, invoices, ...(nextCursor && { nextCursor }) };
  }

  async request(userId: string, invoiceId: string, body: unknown) {
    if (!stripeInvoiceId.test(invoiceId)) throw invoiceNotFound();
    const context = await this.context(userId);
    if (!context) throw invoiceNotFound();
    const { settings, owner, options } = context;
    const source = await this.fromStripe(() =>
      settings.stripe.invoices.retrieve(invoiceId, { expand: ['payments'] }),
    );
    const invoice = cfdiInvoice(source, settings, owner);
    if (!invoice || invoice.id !== invoiceId) throw invoiceNotFound();

    const previous = await this.requests.read(
      settings.table,
      invoiceId,
      owner.householdId,
    );
    if (previous && previous.status !== 'pending') return cfdiReceipt(previous);
    const data = readCfdiRequest(body);
    const request = await this.requests.reserve({
      table: settings.table,
      userId,
      ...owner,
      invoiceId,
      previous,
      data,
    });
    if (!request) {
      const concurrent = await this.requests.read(
        settings.table,
        invoiceId,
        owner.householdId,
      );
      if (concurrent) return cfdiReceipt(concurrent);
      throw new ServiceUnavailableException(
        'La solicitud de factura no está disponible.',
      );
    }

    const result = await this.mail.request(options, request.id, invoice, data);
    if (result.status !== 'sent') {
      this.logger.warn(
        `CFDI request delivery=${result.status} folio=${request.id}`,
      );
    }
    return cfdiReceipt(
      await this.requests.finish(settings.table, invoiceId, request, result),
    );
  }

  private async context(userId: string) {
    const options = this.mail.options();
    if (!options) return undefined;
    const settings = await this.stripeConfig.get();
    if (!settings || settings.stage !== options.stage) return undefined;

    const member = await this.households.findMembershipByUserId(userId);
    if (member?.role !== 'owner') return undefined;
    const household = await this.households.findHouseholdById(
      member.householdId,
    );
    if (household?.ownerUserId !== userId) return undefined;
    const record = await this.billing.read(settings.table, household.id);
    if (
      !record?.customerId ||
      record.closed ||
      record.householdId !== household.id
    )
      return undefined;
    return {
      settings,
      options,
      owner: { householdId: household.id, customerId: record.customerId },
    };
  }

  private async invoiceSummary(
    invoice: NonNullable<ReturnType<typeof cfdiInvoice>>,
    table: string,
    householdId: string,
  ) {
    const { id, paidAt, amountMinor, currency } = invoice;
    const request = await this.requests.read(table, id, householdId);
    return {
      id,
      paidAt,
      amountMinor,
      currency,
      ...(request && { request: cfdiReceipt(request) }),
    };
  }

  private async fromStripe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 404) throw invoiceNotFound();
      if (status === 400)
        throw new BadRequestException('No se reconoce la página solicitada.');
      throw new ServiceUnavailableException(
        'El historial de pagos no está disponible.',
      );
    }
  }
}

function invoiceNotFound() {
  return new NotFoundException(
    'El pago no está disponible para solicitar factura.',
  );
}
