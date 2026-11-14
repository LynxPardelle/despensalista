import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export type BillingAction = 'checkout' | 'portal';

export type SubscriptionStatus =
  | 'none'
  | 'pending'
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export interface BillingPlan {
  label: string;
  amountMinor: number;
  currency: 'mxn';
  interval: 'month';
}

export interface AvailableBillingStatus {
  available: true;
  mode?: 'test' | 'live';
  hasPlus?: boolean;
  canManage: boolean;
  canCheckout: boolean;
  canOpenPortal: boolean;
  plan: BillingPlan;
  status: SubscriptionStatus;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string;
}

type BillingStatus = { available: false } | AvailableBillingStatus;

@Injectable({ providedIn: 'root' })
export class BillingService {
  private readonly http = inject(HttpClient);
  private readonly billingUrl = `${environment.apiUrl}/billing`;

  getStatus(): Observable<BillingStatus> {
    return this.http.get<BillingStatus>(`${this.billingUrl}/status`, {
      withCredentials: true,
      transferCache: false,
    });
  }

  createSession(action: BillingAction, acceptRecurringTerms = false): Observable<string> {
    const body = action === 'checkout' && acceptRecurringTerms
      ? { acceptRecurringTerms: true }
      : {};
    return this.http
      .post<{ url: string }>(`${this.billingUrl}/${action}`, body, { withCredentials: true })
      .pipe(
        map(({ url }) => {
          const destination = new URL(url);
          const stripeOrigin = action === 'checkout'
            ? 'https://checkout.stripe.com'
            : 'https://billing.stripe.com';
          if (destination.origin !== stripeOrigin || destination.username || destination.password) {
            throw new Error('Unrecognized Stripe session URL');
          }
          return destination.href;
        }),
      );
  }
}
