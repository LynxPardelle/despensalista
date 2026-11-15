import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { FeedbackCategory, FeedbackService, FeedbackSubmission } from '../../core/services/feedback.service';
import { getUserErrorMessage } from '../../shared/user-error';

@Component({
  selector: 'app-feedback-page',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './feedback-page.component.html',
  styleUrl: './feedback-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FeedbackPageComponent implements OnInit {
  private readonly feedback = inject(FeedbackService);
  private readonly destroyRef = inject(DestroyRef);
  private pending?: FeedbackSubmission;

  protected readonly form = inject(FormBuilder).nonNullable.group({
    category: ['', Validators.required],
    message: ['', [Validators.required, Validators.maxLength(2_000)]],
  });
  protected readonly availability = signal<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  protected readonly sending = signal(false);
  protected readonly receipt = signal<string | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);

  ngOnInit(): void {
    this.checkAvailability();
  }

  protected checkAvailability(): void {
    this.availability.set('loading');
    this.feedback.isAvailable().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (available) => this.availability.set(available ? 'ready' : 'unavailable'),
      error: () => this.availability.set('error'),
    });
  }

  protected get canSubmit(): boolean {
    return this.form.valid && this.form.controls.message.value.trim().length >= 10 && !this.sending();
  }

  protected submit(): void {
    if (this.availability() !== 'ready' || !this.canSubmit) return;

    const { category, message } = this.form.getRawValue();
    const body = message.trim();
    if (!this.pending || this.pending.category !== category || this.pending.message !== body) {
      this.pending = { submissionId: globalThis.crypto.randomUUID(), category: category as FeedbackCategory, message: body };
    }

    this.receipt.set(undefined);
    this.error.set(undefined);
    this.sending.set(true);
    this.feedback.submit(this.pending).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.sending.set(false)),
    ).subscribe({
      next: ({ id }) => {
        this.pending = undefined;
        this.form.reset();
        this.receipt.set(id);
      },
      error: (error: unknown) => {
        if (error instanceof HttpErrorResponse && error.status === 429) {
          this.error.set('Has llegado al límite diario de reportes. Conserva el texto e inténtalo mañana.');
        } else {
          this.error.set(getUserErrorMessage(error));
        }
      },
    });
  }
}
