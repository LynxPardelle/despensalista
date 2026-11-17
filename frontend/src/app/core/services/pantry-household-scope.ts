import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';

const householdOriginMismatch = 'HOUSEHOLD_ORIGIN_MISMATCH';
const pantryWritePath = /^\/(pantry|product-types|inventory-lots|products)(\/|$|\?)/;
const profilePantryDeletePath = /^\/profile\/pantry-data\/?(?:$|\?)/;

export function isPantryHouseholdMismatch(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.error?.code === householdOriginMismatch;
}

@Injectable({ providedIn: 'root' })
export class PantryHouseholdScope {
  private boundHouseholdId: string | null = null;
  private readonly changed = signal(false);
  readonly stale = this.changed.asReadonly();

  get householdId(): string | null {
    return this.stale() ? null : this.boundHouseholdId;
  }

  bind(householdId: string): boolean {
    if (this.stale()) return false;
    // Never relabel drafts or requests already in progress in this document.
    if (this.boundHouseholdId && this.boundHouseholdId !== householdId) {
      this.markChanged();
    } else {
      this.boundHouseholdId = householdId;
    }
    return !this.stale();
  }

  markChanged(): void {
    this.changed.set(true);
  }
}

export const pantryHouseholdInterceptor: HttpInterceptorFn = (request, next) => {
  const base = environment.apiUrl.replace(/\/$/, '');
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.url.startsWith(`${base}/`)) return next(request);
  const path = request.url.slice(base.length);
  if (!pantryWritePath.test(path) && !(request.method === 'DELETE' && profilePantryDeletePath.test(path))) return next(request);
  const scope = inject(PantryHouseholdScope);
  const householdId = scope.householdId;
  if (!householdId) {
    return throwError(() => new HttpErrorResponse({
      status: 409,
      error: { code: scope.stale() ? householdOriginMismatch : 'HOUSEHOLD_CONTEXT_UNAVAILABLE' },
    }));
  }
  return next(request.clone({ setHeaders: { 'X-Despensa-Household': householdId } })).pipe(
    tap({ error: (error: unknown) => {
      if (isPantryHouseholdMismatch(error)) scope.markChanged();
    } }),
  );
};
