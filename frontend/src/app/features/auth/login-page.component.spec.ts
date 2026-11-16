import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { AuthApiService } from '../../core/services/auth-api.service';
import { AuthFacade } from '../../core/services/auth.facade';
import { LoginPageComponent } from './login-page.component';

describe('LoginPageComponent', () => {
  let fixture: ComponentFixture<LoginPageComponent>;
  let loginPending$: BehaviorSubject<boolean>;
  let authFacade: jasmine.SpyObj<AuthFacade>;

  beforeEach(async () => {
    loginPending$ = new BehaviorSubject(false);
    authFacade = jasmine.createSpyObj<AuthFacade>(
      'AuthFacade',
      ['clearFeedback', 'startCognitoLogin'],
      {
        loginPending$: loginPending$.asObservable(),
        authError$: of(null),
      },
    );

    await TestBed.configureTestingModule({
      declarations: [LoginPageComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: of(convertToParamMap({ redirectTo: '/pantry' })),
            snapshot: {
              queryParamMap: convertToParamMap({ redirectTo: '/pantry' }),
            },
          },
        },
        {
          provide: AuthApiService,
          useValue: {
            getCognitoProviders: () => of(['Google', 'COGNITO']),
            buildCognitoLoginUrl: (_provider: string, redirectTo: string, flow: string) =>
              `/api/auth/cognito/login?redirectTo=${encodeURIComponent(redirectTo)}&flow=${flow}`,
          },
        },
        {
          provide: AuthFacade,
          useValue: authFacade,
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginPageComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    loginPending$.complete();
  });

  it('shows redirect feedback after the user starts Google login', () => {
    fixture.componentInstance.startCognitoLogin('Google');
    loginPending$.next(true);
    fixture.detectChanges();

    expect(authFacade.startCognitoLogin).toHaveBeenCalledWith(
      'Google',
      '/pantry',
    );
    expect(fixture.nativeElement.textContent).toContain(
      'Abriendo Google para iniciar sesión.',
    );
    expect(fixture.nativeElement.textContent).toContain('Abriendo Google...');
  });

  it('shows signup and access feedback and groups recovery choices before starting authentication', () => {
    const links = Array.from(fixture.nativeElement.querySelectorAll('a') as NodeListOf<HTMLAnchorElement>);
    const signup = links.find((link) => link.href.endsWith('redirectTo=%2Fpantry&flow=signup'));
    const nativeRecovery = links.find((link) => link.href.endsWith('redirectTo=%2Fpantry&flow=recovery'));
    const googleRecovery = links.find((link) => link.href === 'https://accounts.google.com/signin/recovery');
    const recoveryReport = links.find((link) => link.href.endsWith('/feedback?source=recovery'));
    const disclosure = nativeRecovery?.closest('details');

    expect(signup?.closest('details')).toBeNull();
    expect(links.some((link) => link.href.endsWith('/feedback?source=access'))).toBeTrue();
    expect(disclosure?.open).toBeFalse();
    expect(googleRecovery?.closest('details')).toBe(disclosure);
    expect(recoveryReport?.closest('details')).toBe(disclosure);
    expect(disclosure?.textContent).toContain('¿Cómo creaste tu cuenta?');
    expect(disclosure?.textContent).toContain('Si aún no confirmaste tu correo, termina primero el registro.');
    disclosure?.querySelector('summary')?.click();
    expect(disclosure?.open).toBeTrue();
    expect(authFacade.startCognitoLogin).not.toHaveBeenCalled();
  });
});
