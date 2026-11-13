import { AsyncPipe } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, DestroyRef, DOCUMENT, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { googleMfaReturnUrl } from '../../core/guards/google-mfa-route';
import { AuthApiService } from '../../core/services/auth-api.service';
import { AuthFacade } from '../../core/services/auth.facade';
import { GoogleMfaStatus } from '../../shared/models/auth.model';

@Component({
  selector: 'app-google-mfa-page',
  imports: [AsyncPipe],
  templateUrl: './google-mfa-page.component.html',
  styleUrl: './login-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoogleMfaPageComponent {
  private readonly api = inject(AuthApiService);
  private readonly auth = inject(AuthFacade);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly abort = new AbortController();

  protected readonly status = signal<GoogleMfaStatus | null>(null);
  protected readonly checking = signal(true);
  protected readonly busy = signal(false);
  protected readonly supported = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly canRetryStatus = signal(false);
  protected readonly authError$ = this.auth.authError$;

  constructor() {
    this.destroyRef.onDestroy(() => this.abort.abort());
    afterNextRender(() => void this.loadStatus());
  }

  protected async loadStatus(): Promise<void> {
    this.checking.set(true);
    this.error.set(null);
    this.canRetryStatus.set(false);
    this.supported.set(
      globalThis.isSecureContext && typeof PublicKeyCredential !== 'undefined' &&
      !!navigator.credentials && typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function' &&
      typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function' &&
      typeof PublicKeyCredential.prototype.toJSON === 'function',
    );

    try {
      const status = await firstValueFrom(this.api.getGoogleMfaStatus());
      if (this.abort.signal.aborted) {
        return;
      }
      this.status.set(status);
      if (status.verified) {
        this.resumeSession();
      } else if (!this.supported()) {
        this.error.set('Usa un navegador actualizado que admita llaves de acceso.');
      }
    } catch (error) {
      const unavailable = error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status);
      this.error.set(unavailable
        ? 'Esta sesión no está disponible para verificar. Vuelve a iniciar sesión.'
        : 'No pudimos cargar la verificación. Inténtalo de nuevo.');
      this.canRetryStatus.set(!unavailable);
    } finally {
      this.checking.set(false);
    }
  }

  protected register(): void {
    void this.runCeremony('registration', async () => {
      const options = await firstValueFrom(this.api.getGoogleMfaOptions('registration'));
      return navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
        signal: this.abort.signal,
      });
    });
  }

  protected authenticate(): void {
    void this.runCeremony('authentication', async () => {
      const options = await firstValueFrom(this.api.getGoogleMfaOptions('authentication'));
      return navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
        signal: this.abort.signal,
      });
    });
  }

  protected logout(): void {
    this.auth.logout();
  }

  private async runCeremony(
    ceremony: 'registration' | 'authentication',
    getCredential: () => Promise<Credential | null>,
  ): Promise<void> {
    const status = this.status();
    if (this.busy() || this.checking() || !this.supported() || !status || status.verified ||
      status.registered !== (ceremony === 'authentication')) {
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.feedback.set(null);
    try {
      const credential = await getCredential();
      if (!(credential instanceof PublicKeyCredential)) {
        throw new DOMException('', 'NotAllowedError');
      }

      if (this.abort.signal.aborted) {
        return;
      }
      await firstValueFrom(this.api.verifyGoogleMfa(ceremony, credential.toJSON()));
      if (this.abort.signal.aborted) {
        return;
      }
      if (ceremony === 'registration') {
        this.status.set({ registered: true, verified: false });
        this.feedback.set('Llave registrada. Verifícala para continuar.');
      } else {
        this.status.set({ registered: true, verified: true });
        this.resumeSession();
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.error.set(this.ceremonyError(error));
      }
    } finally {
      this.busy.set(false);
    }
  }

  private ceremonyError(error: unknown): string {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'El navegador no completó la solicitud de la llave. Inténtalo de nuevo.';
    }
    if (error instanceof HttpErrorResponse && error.status === 401) {
      this.status.set(null);
      return 'La sesión expiró. Vuelve a iniciar sesión.';
    }
    return 'No pudimos confirmar la llave de acceso. Inténtalo de nuevo.';
  }

  private resumeSession(): void {
    const redirectTo = googleMfaReturnUrl(this.route.snapshot.queryParamMap.get('redirectTo'));
    this.document.location.replace(redirectTo ?? '/pantry');
  }
}
