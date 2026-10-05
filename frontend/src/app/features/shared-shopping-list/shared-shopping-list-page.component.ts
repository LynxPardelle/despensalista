import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  OnInit,
  inject,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { take } from 'rxjs';
import { PantryService } from '../../core/services/pantry.service';

@Component({
  selector: 'app-shared-shopping-list-page',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="shared-shopping-page" aria-labelledby="shared-shopping-title">
      <section class="shared-shopping-hero">
        <p class="eyebrow">Despensa Lista</p>
        <h1 id="shared-shopping-title">Lista compartida</h1>
        <p>
          Este enlace muestra una lista de compra temporal. No abre acceso a la
          cuenta ni a la despensa completa. El contenido se carga desde
          Despensa Lista cuando el enlace sigue vigente.
        </p>
      </section>

      @if (errorMessage) {
        <section class="error-banner" role="alert">
          <strong>{{ errorMessage }}</strong>
          @if (retryable) {
            <button
              class="ghost-button retry-button"
              type="button"
              (click)="retry()"
            >
              Reintentar
            </button>
          }
          <a class="ghost-button" routerLink="/pantry">Ir a Despensa Lista</a>
        </section>
      } @else if (loading) {
        <section class="shared-shopping-card" aria-live="polite">
          <p class="helper-copy">Cargando lista compartida...</p>
        </section>
      } @else if (sharedText) {
        <section class="shared-shopping-card">
          @if (expiresAt) {
            <p class="helper-copy">
              Disponible hasta
              {{ expiresAt | date: 'dd MMM y, HH:mm' : 'UTC' }} UTC.
            </p>
          }

          <textarea
            class="shopping-export-text"
            aria-label="Lista de compras compartida"
            [value]="sharedText"
            readonly
          ></textarea>

          <a
            class="ghost-button whatsapp-link"
            [href]="getWhatsAppShoppingUrl(sharedText)"
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir en WhatsApp
          </a>
        </section>
      }
    </main>
  `,
  styles: [
    `
      .shared-shopping-page {
        width: min(760px, calc(100% - 2rem));
        margin: 0 auto;
        padding: 2rem 0 3rem;
      }

      .shared-shopping-hero,
      .shared-shopping-card,
      .error-banner {
        border: 1px solid var(--color-border);
        border-radius: 24px;
        background: var(--color-surface-elevated);
        box-shadow: var(--shadow-soft);
        padding: 1.5rem;
      }

      .shared-shopping-card,
      .error-banner {
        display: grid;
        gap: 1rem;
        margin-top: 1rem;
      }

      .shared-shopping-hero h1 {
        margin: 0;
        font-size: clamp(2.1rem, 5vw, 3.2rem);
      }

      .shopping-export-text {
        width: 100%;
        min-height: 16rem;
        resize: vertical;
      }
    `,
  ],
})
export class SharedShoppingListPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly pantryService = inject(PantryService);
  private readonly changeDetector = inject(ChangeDetectorRef);

  sharedText: string | null = null;
  expiresAt: Date | null = null;
  errorMessage: string | null = null;
  loading = false;
  retryable = false;

  private token: string | null = null;

  ngOnInit(): void {
    this.route.queryParamMap.pipe(take(1)).subscribe((params) => {
      const token = params.get('token');

      if (!token) {
        this.errorMessage = 'Enlace inválido.';
        return;
      }

      this.token = token;
      this.loadShare(token);
    });
  }

  retry(): void {
    if (this.token) {
      this.loadShare(this.token);
    }
  }

  private loadShare(token: string): void {
    this.loading = true;
    this.retryable = false;
    this.errorMessage = null;
    this.sharedText = null;
    this.expiresAt = null;
    this.pantryService
      .resolveShoppingShare(token)
        .pipe(take(1))
        .subscribe({
          next: (share) => {
            this.loading = false;
            this.sharedText = share.text;
            this.expiresAt = share.expiresAt;
            this.changeDetector.markForCheck();
          },
          error: (error) => {
            this.loading = false;
            this.errorMessage = this.getShareErrorMessage(error);
            this.retryable = this.isRetryableError(error);
            this.changeDetector.markForCheck();
          },
        });
  }

  getWhatsAppShoppingUrl(exportText: string): string {
    return `https://wa.me/?text=${encodeURIComponent(exportText)}`;
  }

  private getShareErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.status === 410) {
      return 'Este enlace ya caducó o fue revocado.';
    }

    if (this.isRetryableError(error)) {
      return 'No pudimos cargar la lista. Revisa tu conexión e intenta de nuevo.';
    }

    return 'Enlace inválido.';
  }

  private isRetryableError(error: unknown): boolean {
    return (
      error instanceof HttpErrorResponse &&
      (error.status === 0 || error.status >= 500)
    );
  }
}
