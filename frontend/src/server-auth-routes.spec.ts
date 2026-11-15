import {
  buildLoginRedirectPath,
  createProtectedRouteRedirect,
  hasAuthSessionCookie,
  isProtectedAppRoute,
} from './server-auth-routes';

describe('server auth route protection', () => {
  it('detects protected app routes without matching similar public paths', () => {
    expect(isProtectedAppRoute('/pantry')).toBeTrue();
    expect(isProtectedAppRoute('/pantry/')).toBeTrue();
    expect(isProtectedAppRoute('/pantry/archive')).toBeTrue();
    expect(isProtectedAppRoute('/profile')).toBeTrue();
    expect(isProtectedAppRoute('/profile/preferences')).toBeTrue();
    expect(isProtectedAppRoute('/feedback')).toBeTrue();
    expect(isProtectedAppRoute('/feedback-assets')).toBeFalse();
    expect(isProtectedAppRoute('/pantry-assets/app.css')).toBeFalse();
    expect(isProtectedAppRoute('/login')).toBeFalse();
  });

  it('detects non-empty DespensaLista session cookies', () => {
    expect(
      hasAuthSessionCookie('theme=light; despensalista_access_token=abc; other=1'),
    ).toBeTrue();
    expect(hasAuthSessionCookie('despensalista_refresh_token=refresh')).toBeTrue();
    expect(hasAuthSessionCookie('despensalista_access_token=; other=1')).toBeFalse();
    expect(hasAuthSessionCookie(undefined)).toBeFalse();
  });

  it('builds a local login redirect target from path and query', () => {
    expect(
      buildLoginRedirectPath(
        new URL('https://despensalista.local/pantry?tab=basicos'),
      ),
    ).toBe('/login?redirectTo=%2Fpantry%3Ftab%3Dbasicos');
  });

  it('redirects unauthenticated protected SSR requests before rendering', () => {
    const middleware = createProtectedRouteRedirect();
    const next = jasmine.createSpy('next');
    const res = makeResponse();

    middleware(
      {
        method: 'GET',
        originalUrl: '/pantry',
        headers: {},
      } as never,
      res as never,
      next,
    );

    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      '/login?redirectTo=%2Fpantry',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('lets authenticated and public SSR requests continue', () => {
    const middleware = createProtectedRouteRedirect();
    const next = jasmine.createSpy('next');
    const res = makeResponse();

    middleware(
      {
        method: 'GET',
        originalUrl: '/profile',
        headers: { cookie: 'despensalista_refresh_token=refresh' },
      } as never,
      res as never,
      next,
    );
    middleware(
      {
        method: 'GET',
        originalUrl: '/login',
        headers: {},
      } as never,
      res as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

function makeResponse(): {
  redirect: jasmine.Spy;
  setHeader: jasmine.Spy;
} {
  return {
    redirect: jasmine.createSpy('redirect'),
    setHeader: jasmine.createSpy('setHeader'),
  };
}
