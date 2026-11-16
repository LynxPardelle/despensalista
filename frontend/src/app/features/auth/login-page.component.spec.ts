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

  it('offers separate links for email signup, password recovery, Google recovery and access feedback', () => {
    const links = Array.from(fixture.nativeElement.querySelectorAll('a') as NodeListOf<HTMLAnchorElement>);

    expect(links.some((link) => link.href.endsWith('redirectTo=%2Fpantry&flow=signup'))).toBeTrue();
    expect(links.some((link) => link.href.endsWith('redirectTo=%2Fpantry&flow=recovery'))).toBeTrue();
    expect(links.some((link) => link.href === 'https://accounts.google.com/signin/recovery')).toBeTrue();
    expect(links.some((link) => link.href.endsWith('/feedback?source=access'))).toBeTrue();
  });
});
