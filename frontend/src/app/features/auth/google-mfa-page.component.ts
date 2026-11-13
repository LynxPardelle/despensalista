import { AsyncPipe } from '@angular/common';
import {
  afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, DOCUMENT,
  ElementRef, inject, signal, viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { googleMfaReturnUrl } from '../../core/guards/google-mfa-route';
import { AuthApiService, isGoogleMfaRequired } from '../../core/services/auth-api.service';
import { AuthFacade } from '../../core/services/auth.facade';
import { GoogleMfaStatus } from '../../shared/models/auth.model';

type Ceremony = 'registration' | 'authentication' | 'recovery';

@Component({
  selector: 'app-google-mfa-page',
  imports: [AsyncPipe],
  templateUrl: './google-mfa-page.component.html',
  styleUrl: './login-page.component.scss',
  styles: '#google-mfa-recovery-code { overflow-wrap: anywhere; user-select: all; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:pagehide)': 'clearRecoverySecrets()' },
})
export class GoogleMfaPageComponent {
  private readonly api = inject(AuthApiService);
  private readonly auth = inject(AuthFacade);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly abort = new AbortController();
  private readonly manage = this.route.snapshot.queryParamMap.get('manage') === '1';
  private readonly recoveryInput = viewChild<ElementRef<HTMLInputElement>>('recoveryInput');
  private readonly recoveryOutput = viewChild<ElementRef<HTMLOutputElement>>('recoveryOutput');
  private recoveryDisplayVersion = 0;

  protected readonly status = signal<GoogleMfaStatus | null>(null);
  protected readonly checking = signal(true);
  protected readonly busy = signal(false);
  protected readonly supported = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly canRetryStatus = signal(false);
  protected readonly authError$ = this.auth.authError$;
  protected readonly managing = computed(() => this.manage && this.status()?.verified === true);
  protected readonly recoveryOpen = signal(false);
  protected readonly replacingCode = signal(false);
  protected readonly recoveryCode = signal<string | null>(null);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.abort.abort();
      this.clearRecoverySecrets();
    });
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
      if (status.verified && !this.manage) {
        this.resumeSession();
      } else if (!this.supported()) {
        this.error.set('Usa un navegador actualizado que admita llaves de acceso.');
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const unavailable = error instanceof HttpErrorResponse && [401, 403, 404].includes(error.status);
      if (unavailable) this.status.set(null);
      this.error.set(unavailable
        ? 'Esta sesión no está disponible para verificar. Vuelve a iniciar sesión.'
        : 'No pudimos cargar la verificación. Inténtalo de nuevo.');
      this.canRetryStatus.set(!unavailable);
    } finally {
      this.checking.set(false);
    }
  }

  protected register(): void {
    void this.runCeremony('registration', () => this.createKey(
      firstValueFrom(this.api.getGoogleMfaOptions('registration')),
    ));
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
    this.clearRecoverySecrets();
    this.auth.logout();
  }

  protected returnToProfile(): void {
    this.clearRecoverySecrets();
    this.document.location.replace('/profile');
  }

  protected recover(event: Event, input: HTMLInputElement): void {
    event.preventDefault();
    const code = input.value.trim();
    input.value = '';
    if (!code) {
      this.error.set('Ingresa el código de recuperación.');
      return;
    }
    void this.runCeremony('recovery', () => this.createKey(
      firstValueFrom(this.api.getGoogleMfaOptions('recovery', code)),
    ));
  }

  protected async generateRecoveryCode(): Promise<void> {
    const status = this.status();
    if (this.busy() || this.checking() || !this.managing() || !status?.recentVerification ||
      this.recoveryCode() || (status.recoveryConfigured && !this.replacingCode())) {
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    this.feedback.set(null);
    const displayVersion = this.recoveryDisplayVersion;
    try {
      const { code } = await firstValueFrom(this.api.generateGoogleMfaRecoveryCode());
      if (!this.abort.signal.aborted) {
        this.status.set({ ...status, recoveryConfigured: true });
        this.replacingCode.set(false);
        if (displayVersion === this.recoveryDisplayVersion) this.recoveryCode.set(code);
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.error.set(this.ceremonyError(error, 'code'));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected clearRecoverySecrets(): void {
    this.recoveryDisplayVersion += 1;
    const input = this.recoveryInput()?.nativeElement;
    const output = this.recoveryOutput()?.nativeElement;
    if (input) input.value = '';
    if (output) output.textContent = '';
    this.recoveryCode.set(null);
  }

  private async createKey(optionsPromise: Promise<PublicKeyCredentialCreationOptionsJSON>): Promise<Credential | null> {
    const options = await optionsPromise;
    return navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
      signal: this.abort.signal,
    });
  }

  private async runCeremony(
    ceremony: Ceremony,
    getCredential: () => Promise<Credential | null>,
  ): Promise<void> {
    const status = this.status();
    if (this.busy() || this.checking() || !this.supported() || !status || this.recoveryCode() ||
      !this.canStartCeremony(ceremony, status)) {
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
      this.finishCeremony(ceremony, status);
    } catch (error) {
      if (!this.abort.signal.aborted) {
        const conflict = error instanceof HttpErrorResponse && error.status === 409;
        if (conflict) await this.loadStatus();
        this.error.set(this.ceremonyError(error, ceremony));
      }
    } finally {
      this.busy.set(false);
    }
  }

  private canStartCeremony(
    ceremony: Ceremony, status: GoogleMfaStatus,
  ): boolean {
    switch (ceremony) {
      case 'authentication':
        return status.registered && (!status.verified || this.managing());
      case 'registration':
        return this.managing()
          ? status.keyCount === 1 && status.recentVerification
          : !status.verified && !status.registered;
      case 'recovery':
        return !status.verified && status.recoveryConfigured && this.recoveryOpen();
    }
  }

  private finishCeremony(ceremony: Ceremony, status: GoogleMfaStatus): void {
    this.recoveryOpen.set(false);
    if (ceremony === 'authentication') {
      this.status.set({ ...status, verified: true, recentVerification: true });
      if (this.manage) {
        this.feedback.set('Llave confirmada. Puedes actualizar tus opciones de seguridad.');
      } else {
        this.resumeSession();
      }
      return;
    }

    if (ceremony === 'recovery') {
      this.status.set({ registered: true, verified: false, keyCount: 1, recoveryConfigured: false, recentVerification: false });
      this.feedback.set('Llave nueva registrada. Verifícala para entrar y genera otro código desde tu perfil.');
      return;
    }

    this.status.set({ ...status, registered: true, keyCount: status.verified ? 2 : 1 });
    this.feedback.set(status.verified
      ? 'Registraste una segunda llave. Puedes usar cualquiera de las dos para entrar.'
      : 'Llave registrada. Verifícala para continuar.');
  }

  private ceremonyError(error: unknown, ceremony: Ceremony | 'code'): string {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'El navegador no completó la solicitud de la llave. Inténtalo de nuevo.';
    }
    if (error instanceof HttpErrorResponse && error.status === 401) {
      this.status.set(null);
      this.recoveryOpen.set(false);
      this.replacingCode.set(false);
      return 'La sesión expiró. Vuelve a iniciar sesión.';
    }
    if (isGoogleMfaRequired(error)) {
      this.status.update((status) => status && { ...status, recentVerification: false });
      this.replacingCode.set(false);
      return 'Confirma de nuevo con una llave para continuar.';
    }
    if (error instanceof HttpErrorResponse && error.status === 429) {
      return 'Hay demasiados intentos. Espera antes de volver a intentarlo.';
    }
    if (error instanceof HttpErrorResponse && error.status === 409) {
      return 'Las opciones de seguridad cambiaron. Revisa el estado actual e inténtalo de nuevo.';
    }
    if (ceremony === 'recovery') {
      return 'No pudimos recuperar el acceso. Revisa el código e inténtalo de nuevo.';
    }
    if (ceremony === 'code') {
      return 'No pudimos mostrar un código de recuperación. Vuelve a intentarlo.';
    }
    return 'No pudimos confirmar la llave de acceso. Inténtalo de nuevo.';
  }

  private resumeSession(): void {
    const redirectTo = googleMfaReturnUrl(this.route.snapshot.queryParamMap.get('redirectTo'));
    this.document.location.replace(redirectTo ?? '/pantry');
  }
}
