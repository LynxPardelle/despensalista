import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { AuthApiService } from '../../core/services/auth-api.service';
import { AuthFacade } from '../../core/services/auth.facade';

interface LoginProviderOption {
  provider: string;
  label: string;
  primary: boolean;
}

@Component({
  selector: 'app-login-page',
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class LoginPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly authApiService = inject(AuthApiService);
  private readonly authFacade = inject(AuthFacade);

  readonly appName = environment.appName;
  readonly loginPending$ = this.authFacade.loginPending$;
  readonly authError$ = this.authFacade.authError$;
  readonly callbackError$ = this.route.queryParamMap.pipe(
    map((params) => this.getCallbackErrorMessage(params.get('authError'))),
  );
  readonly providerOptions$: Observable<LoginProviderOption[]> =
    this.authApiService.getCognitoProviders().pipe(
      map((providers) => this.toProviderOptions(providers)),
      catchError(() => of(this.toProviderOptions(['COGNITO']))),
    );
  pendingProvider: string | null = null;

  ngOnInit(): void {
    this.authFacade.clearFeedback();
  }

  startCognitoLogin(provider?: string): void {
    this.pendingProvider = provider ?? 'COGNITO';
    this.authFacade.startCognitoLogin(
      provider,
      this.route.snapshot.queryParamMap.get('redirectTo'),
    );
  }

  getPendingButtonLabel(provider: string): string {
    return `Abriendo ${this.getProviderDisplayName(provider)}...`;
  }

  getLoginRedirectStatusMessage(): string {
    return `Abriendo ${this.getProviderDisplayName(
      this.pendingProvider ?? 'COGNITO',
    )} para iniciar sesión.`;
  }

  hasSocialProviders(options: LoginProviderOption[]): boolean {
    return options.some((option) => option.provider !== 'COGNITO');
  }

  private toProviderOptions(providers: string[]): LoginProviderOption[] {
    const normalizedProviders = providers.length ? providers : ['COGNITO'];
    const hasSocialProviders = normalizedProviders.some(
      (provider) => provider !== 'COGNITO',
    );

    return normalizedProviders.map((provider) => ({
      provider,
      label: this.getProviderLabel(provider),
      primary: hasSocialProviders
        ? provider === 'Google'
        : provider === 'COGNITO',
    }));
  }

  private getProviderLabel(provider: string): string {
    const labels: Record<string, string> = {
      Google: 'Entrar con Google',
      Facebook: 'Entrar con Facebook',
      COGNITO: 'Entrar con correo',
    };

    return labels[provider] ?? `Entrar con ${provider}`;
  }

  private getProviderDisplayName(provider: string): string {
    const labels: Record<string, string> = {
      Google: 'Google',
      Facebook: 'Facebook',
      COGNITO: 'correo',
    };

    return labels[provider] ?? provider;
  }

  private getCallbackErrorMessage(error: string | null): string | null {
    const messages: Record<string, string> = {
      cognito_state:
        'El inicio de sesion caduco o se abrio otro intento. Vuelve a elegir tu proveedor.',
      cognito_callback:
        'No recibimos la confirmación de acceso. Vuelve a iniciar sesión.',
    };

    return error
      ? (messages[error] ?? 'No pudimos completar el inicio de sesion.')
      : null;
  }
}
