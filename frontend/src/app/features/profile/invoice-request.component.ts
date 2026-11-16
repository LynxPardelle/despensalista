import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize, merge } from 'rxjs';
import {
  type FiscalCatalog,
  InvoiceRequestService,
  type PaidInvoice,
} from '../../core/services/invoice-request.service';

const paymentDate = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'America/Mexico_City',
});
const paymentAmount = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  currencyDisplay: 'code',
});
const rfcPattern = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/i;
const genericRfcs = new Set(['XAXX010101000', 'XEXX010101000']);

@Component({
  selector: 'app-invoice-request',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './invoice-request.component.html',
  styleUrl: './invoice-request.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvoiceRequestComponent {
  private readonly invoicesService = inject(InvoiceRequestService);
  private readonly destroyRef = inject(DestroyRef);
  readonly testMode = input(false);

  protected readonly expanded = signal(false);
  protected readonly available = signal<boolean | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal(false);
  protected readonly sending = signal(false);
  protected readonly sendError = signal<string | null>(null);
  protected readonly invoices = signal<PaidInvoice[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly catalog = signal<FiscalCatalog | null>(null);
  protected readonly accountEmail = signal<string | null>(null);
  protected readonly selectedId = signal('');
  protected readonly selectedInvoice = computed(() =>
    this.invoices().find((invoice) => invoice.id === this.selectedId()),
  );
  protected readonly canEnterDetails = computed(() => {
    const invoice = this.selectedInvoice();
    return !!invoice && (!invoice.request ||
      (invoice.request.status === 'pending' && invoice.request.retryable === true));
  });
  protected readonly fiscalForm = inject(NonNullableFormBuilder).group({
    rfc: ['', [Validators.required, Validators.pattern(rfcPattern)]],
    legalName: ['', [Validators.required, Validators.pattern(/\S/), Validators.maxLength(254)]],
    postalCode: ['', [Validators.required, Validators.pattern(/^\d{5}$/)]],
    taxRegime: [{ value: '', disabled: true }, [Validators.required, Validators.pattern(/^6\d{2}$/)]],
    cfdiUse: [{ value: '', disabled: true }, [Validators.required, Validators.pattern(/^[A-Z]{1,2}\d{2}$/i)]],
    additionalEmail: ['', [Validators.email, Validators.maxLength(254)]],
  });
  private readonly rfc = toSignal(this.fiscalForm.controls.rfc.valueChanges, {
    initialValue: '',
  });
  private readonly regimeCode = toSignal(this.fiscalForm.controls.taxRegime.valueChanges, {
    initialValue: '',
  });
  protected readonly recipientKind = computed(() => {
    const rfc = this.rfc().trim().toUpperCase();
    if (!rfcPattern.test(rfc)) return null;
    if (genericRfcs.has(rfc)) return 'generic';
    return rfc.length === 13 ? 'individual' : 'organization';
  });
  protected readonly regimeOptions = computed(() => {
    const recipient = this.recipientKind();
    if (!recipient) return [];
    return (this.catalog()?.regimes ?? []).filter((regime) =>
      recipient === 'generic' ? regime.code === '616' : regime[recipient],
    );
  });
  protected readonly useOptions = computed(() => {
    const recipient = this.recipientKind();
    const regime = this.regimeCode();
    if (!recipient || !this.regimeOptions().some(({ code }) => code === regime)) return [];
    return (this.catalog()?.uses ?? []).filter((use) =>
      use.regimes.includes(regime) && (recipient === 'generic' ? use.code === 'S01' : use[recipient]),
    );
  });

  constructor() {
    const { rfc, taxRegime } = this.fiscalForm.controls;
    merge(rfc.valueChanges, taxRegime.valueChanges)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.updateFiscalSelections());
  }

  protected toggle(): void {
    if (this.sending()) return;
    this.expanded.update((expanded) => !expanded);
    if (this.expanded()) this.loadInvoices();
    else this.selectInvoice('');
  }

  protected loadInvoices(cursor?: string): void {
    if (this.loading() || this.sending()) return;
    this.loading.set(true);
    this.loadError.set(false);
    this.invoicesService.list(cursor).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading.set(false)),
    ).subscribe({
      next: ({ available, invoices, nextCursor, catalog, accountEmail }) => {
        this.available.set(available);
        this.nextCursor.set(nextCursor ?? null);
        this.invoices.update((current) => cursor ? [...current, ...invoices] : invoices);
        this.catalog.set(catalog ?? null);
        this.accountEmail.set(accountEmail ?? null);
        if (!this.selectedInvoice()) {
          this.selectInvoice('');
        } else if (!this.canEnterDetails()) {
          this.fiscalForm.reset();
          this.sendError.set(null);
        } else {
          this.updateFiscalSelections();
        }
      },
      error: () => this.loadError.set(true),
    });
  }

  protected selectInvoice(id: string): void {
    this.selectedId.set(id);
    this.fiscalForm.reset();
    this.sendError.set(null);
  }

  protected formatInvoice(invoice: PaidInvoice): string {
    return `${paymentDate.format(new Date(invoice.paidAt))} · ${paymentAmount.format(invoice.amountMinor / 100)}`;
  }

  protected submit(): void {
    if (!this.available() || this.loading() || this.sending() || !this.canEnterDetails()) return;
    this.fiscalForm.markAllAsTouched();
    if (!this.fiscalForm.valid) return;

    const invoiceId = this.selectedId();
    const { rfc, legalName, postalCode, taxRegime, cfdiUse, additionalEmail } =
      this.fiscalForm.getRawValue();
    if (!this.useOptions().some(({ code }) => code === cfdiUse)) return;
    const copyAddress = additionalEmail.trim();
    const isNewAddress =
      !!copyAddress && copyAddress.toLowerCase() !== this.accountEmail()?.toLowerCase();
    this.sendError.set(null);
    this.sending.set(true);
    this.invoicesService.request(invoiceId, {
      rfc: rfc.trim().toUpperCase(),
      legalName: legalName.trim().toUpperCase(),
      postalCode,
      taxRegime,
      cfdiUse: cfdiUse.toUpperCase(),
      ...(isNewAddress ? { additionalEmail: copyAddress } : {}),
    }).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.sending.set(false)),
    ).subscribe({
      next: (request) => {
        this.invoices.update((invoices) => invoices.map((invoice) =>
          invoice.id === invoiceId ? { ...invoice, request } : invoice,
        ));
        if (!this.canEnterDetails()) this.fiscalForm.reset();
      },
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.status === 400) {
          this.sendError.set('Revisa tus datos fiscales e inténtalo de nuevo.');
        } else if (error instanceof HttpErrorResponse && [403, 404, 409].includes(error.status)) {
          this.sendError.set('El pago o la solicitud ya no está disponible. Actualiza los pagos.');
        } else {
          this.sendError.set('No pudimos confirmar tu solicitud. Actualiza los pagos para revisar su estado.');
        }
      },
    });
  }

  private updateFiscalSelections(): void {
    const { taxRegime, cfdiUse } = this.fiscalForm.controls;
    const regimes = this.regimeOptions();
    if (taxRegime.value && !regimes.some(({ code }) => code === taxRegime.value)) {
      taxRegime.reset();
    }
    this.setSelectionAvailability(taxRegime, regimes.length > 0);

    const uses = this.useOptions();
    if (cfdiUse.value && !uses.some(({ code }) => code === cfdiUse.value)) {
      cfdiUse.reset();
    }
    this.setSelectionAvailability(cfdiUse, uses.length > 0);
  }

  private setSelectionAvailability(control: AbstractControl, available: boolean): void {
    if (available && control.disabled) {
      control.enable({ emitEvent: false });
    } else if (!available && control.enabled) {
      control.disable({ emitEvent: false });
    }
  }
}
