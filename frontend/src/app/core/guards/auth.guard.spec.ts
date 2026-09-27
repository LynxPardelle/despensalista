import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { RouterTestingModule } from '@angular/router/testing';
import { BehaviorSubject, Observable, firstValueFrom, isObservable } from 'rxjs';
import { AuthFacade } from '../services/auth.facade';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let authFacade: AuthFacadeStub;

  beforeEach(() => {
    authFacade = new AuthFacadeStub();

    TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      providers: [
        AuthGuard,
        {
          provide: AuthFacade,
          useValue: authFacade,
        },
        {
          provide: PLATFORM_ID,
          useValue: 'browser',
        },
      ],
    });

    guard = TestBed.inject(AuthGuard);
    clearXsrfCookie();
  });

  afterEach(() => {
    clearXsrfCookie();
  });

  it('skips bootstrap on anonymous routes when no xsrf cookie exists', async () => {
    const result = await resolveGuardResult(
      guard.canActivate(
        {
          data: { authMode: 'anonymous' },
        } as unknown as ActivatedRouteSnapshot,
        {
          url: '/login',
        } as unknown as RouterStateSnapshot,
      ),
    );

    expect(result).toBeTrue();
    expect(authFacade.bootstrap).not.toHaveBeenCalled();
  });

  it('preserves an invitation when an existing session visits the login route', async () => {
    document.cookie = 'XSRF-TOKEN=test; path=/';
    authFacade.sessionStatus$.next('authenticated');
    const invitation = '/profile?householdInvite=fresh-token';
    const result = await resolveGuardResult(guard.canActivate({
      data: { authMode: 'anonymous' },
      queryParamMap: convertToParamMap({ redirectTo: invitation }),
    } as unknown as ActivatedRouteSnapshot, { url: '/login' } as RouterStateSnapshot));
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe(invitation);
  });

  it('preserves the requested invitation route while asking an anonymous user to sign in', async () => {
    const invitation = '/profile?householdInvite=fresh-token';
    const result = await resolveGuardResult(guard.canActivate({
      data: { authMode: 'authenticated' },
    } as unknown as ActivatedRouteSnapshot, { url: invitation } as RouterStateSnapshot));
    expect((result as UrlTree).queryParams['redirectTo']).toBe(invitation);
  });

  it('rejects external login return destinations for an existing session', async () => {
    document.cookie = 'XSRF-TOKEN=test; path=/';
    authFacade.sessionStatus$.next('authenticated');
    for (const redirectTo of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const result = await resolveGuardResult(guard.canActivate({
        data: { authMode: 'anonymous' }, queryParamMap: convertToParamMap({ redirectTo }),
      } as unknown as ActivatedRouteSnapshot, { url: '/login' } as RouterStateSnapshot));
      expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/pantry');
    }
  });
});

class AuthFacadeStub {
  readonly sessionStatus$ = new BehaviorSubject<'unknown' | 'authenticated' | 'anonymous'>('unknown');
  readonly bootstrapPending$ = new BehaviorSubject(false);
  readonly refreshPending$ = new BehaviorSubject(false);
  readonly bootstrap = jasmine.createSpy('bootstrap').and.callFake(() => {
    this.sessionStatus$.next('anonymous');
  });
}

async function resolveGuardResult(
  result: boolean | UrlTree | Observable<boolean | UrlTree>,
): Promise<boolean | UrlTree> {
  return isObservable(result) ? firstValueFrom(result) : result;
}

function clearXsrfCookie(): void {
  document.cookie = 'XSRF-TOKEN=; Max-Age=0; path=/';
}
