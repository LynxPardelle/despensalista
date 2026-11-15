import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { finalize, timeout } from 'rxjs';
import { PantryService } from '../../core/services/pantry.service';
import type { PlusHouseholdSummary } from '../../shared/models/pantry.model';
import { getUserErrorMessage } from '../../shared/user-error';

@Component({
  selector: 'app-plus-household-summary',
  imports: [CurrencyPipe, DatePipe, DecimalPipe, RouterLink],
  templateUrl: './plus-household-summary.component.html',
  styles: `
    .summary-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .75rem; }
    .summary-header h2 { margin: 0; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: 1rem; }
    .summary-grid section { min-width: 0; }
    .summary-grid ul { margin: 0; padding-inline-start: 1.2rem; }
    .summary-grid h3 { font-size: 1rem; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlusHouseholdSummaryComponent {
  private readonly pantry = inject(PantryService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly summary = signal<PlusHouseholdSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly needsPlus = signal(false);
  protected readonly error = signal('');

  protected load() {
    if (this.loading()) return;
    this.loading.set(true);
    this.needsPlus.set(false);
    this.error.set('');
    this.summary.set(null);
    this.pantry.getPlusHouseholdSummary().pipe(
      timeout(15_000),
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.loading.set(false)),
    ).subscribe({
      next: (summary) => this.summary.set(summary),
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.status === 403 && error.error?.code === 'PLUS_REQUIRED') {
          this.needsPlus.set(true);
        } else {
          this.error.set(getUserErrorMessage(error));
        }
      },
    });
  }
}
