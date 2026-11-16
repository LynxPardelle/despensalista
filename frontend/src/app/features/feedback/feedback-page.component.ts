import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { FeedbackCategory, FeedbackChannel, FeedbackService, FeedbackSubmission, feedbackErrorCodes, feedbackSources } from '../../core/services/feedback.service';
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
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;
  private readonly source = feedbackSources.find((value) => value === this.query.get('source'));
  private readonly errorCode = feedbackErrorCodes.find((value) => value === this.query.get('errorCode'));
  private pending?: FeedbackSubmission;
  private deliveryUncertain = false;

  protected readonly form = inject(FormBuilder).nonNullable.group({
    category: ['', Validators.required],
    message: ['', [Validators.required, Validators.maxLength(2_000)]],
  });
  protected readonly availability = signal<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  protected readonly sending = signal(false);
  protected readonly channel = signal<FeedbackChannel>('account');
  protected readonly canSendWithoutSession = signal(false);
  protected readonly receipt = signal<string | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);

  ngOnInit(): void {
    this.checkAvailability();
  }

  protected checkAvailability(): void {
    this.availability.set('loading');
    const channel = this.channel();
    this.feedback.isAvailable(channel).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (available) => this.availability.set(available ? 'ready' : 'unavailable'),
      error: (error: unknown) => {
        if (channel === 'account' && this.sessionRejected(error)) {
          this.sendWithoutSession();
        } else {
          this.availability.set('error');
        }
      },
    });
  }

  protected sendWithoutSession(): void {
    this.channel.set('anonymous');
    this.canSendWithoutSession.set(false);
    this.pending = undefined;
    this.deliveryUncertain = false;
    this.error.set(undefined);
    this.checkAvailability();
  }

  protected get canSubmit(): boolean {
    return this.form.valid && this.form.controls.message.value.trim().length >= 10 && !this.sending();
  }

  protected submit(): void {
    if (this.availability() !== 'ready' || !this.canSubmit) return;

    const { category, message } = this.form.getRawValue();
    const body = message.trim();
    if (!this.pending || this.pending.category !== category || this.pending.message !== body) {
      this.pending = {
        submissionId: globalThis.crypto.randomUUID(),
        category: category as FeedbackCategory,
        message: body,
        ...(this.source && { source: this.source }),
        ...(this.errorCode && { errorCode: this.errorCode }),
      };
      this.deliveryUncertain = false;
    }

    this.receipt.set(undefined);
    this.error.set(undefined);
    this.canSendWithoutSession.set(false);
    this.sending.set(true);
    const channel = this.channel();
    this.feedback.submit(this.pending, channel).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.sending.set(false)),
    ).subscribe({
      next: ({ id }) => {
        this.pending = undefined;
        this.deliveryUncertain = false;
        this.form.reset();
        this.receipt.set(id);
      },
      error: (error: unknown) => {
        if (channel === 'account' && this.sessionRejected(error) && !this.deliveryUncertain) {
          this.canSendWithoutSession.set(true);
          this.error.set('No pudimos confirmar tu sesión. Puedes conservar el texto y enviarlo sin iniciar sesión.');
        } else if (error instanceof HttpErrorResponse && error.status === 429) {
          this.error.set('Has llegado al límite diario de reportes. Conserva el texto e inténtalo mañana.');
        } else {
          this.deliveryUncertain ||= !(error instanceof HttpErrorResponse) || error.status === 0 || error.status >= 500;
          this.error.set(getUserErrorMessage(error));
        }
      },
    });
  }

  private sessionRejected(error: unknown): boolean {
    return error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403);
  }
}
