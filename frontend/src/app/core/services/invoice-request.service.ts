import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface FiscalDetails {
  rfc: string;
  legalName: string;
  postalCode: string;
  taxRegime: string;
  cfdiUse: string;
  email?: string;
}

export interface InvoiceRequestReceipt {
  id: string;
  status: 'pending' | 'sent' | 'delivery_unknown';
  retryable?: boolean;
}

export interface PaidInvoice {
  id: string;
  paidAt: string;
  amountMinor: number;
  currency: 'mxn';
  request?: InvoiceRequestReceipt;
}

interface InvoicePage {
  available: boolean;
  invoices: PaidInvoice[];
  nextCursor?: string | null;
}

@Injectable({ providedIn: 'root' })
export class InvoiceRequestService {
  private readonly http = inject(HttpClient);
  private readonly invoicesUrl = `${environment.apiUrl}/billing/invoices`;

  list(cursor?: string): Observable<InvoicePage> {
    return this.http.get<InvoicePage>(this.invoicesUrl, {
      withCredentials: true,
      transferCache: false,
      ...(cursor ? { params: { cursor } } : {}),
    });
  }

  request(invoiceId: string, details: FiscalDetails): Observable<InvoiceRequestReceipt> {
    const url = `${this.invoicesUrl}/${encodeURIComponent(invoiceId)}/cfdi-requests`;
    return this.http.post<InvoiceRequestReceipt>(url, details, { withCredentials: true });
  }
}
