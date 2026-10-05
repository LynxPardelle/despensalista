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
});
