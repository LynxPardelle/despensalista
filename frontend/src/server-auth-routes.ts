import type { NextFunction, Request, RequestHandler, Response } from 'express';

const PROTECTED_APP_ROUTES = ['/pantry', '/profile'];
const SESSION_COOKIE_PATTERN =
  /(?:^|;\s*)despensalista_(?:access|refresh)_token=[^;\s]+/;

export function createProtectedRouteRedirect(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      next();
      return;
    }

    const requestUrl = new URL(
      req.originalUrl || req.url || '/',
      'https://despensalista.local',
    );

    if (
      !isProtectedAppRoute(requestUrl.pathname) ||
      hasAuthSessionCookie(req.headers.cookie)
    ) {
      next();
      return;
    }

    res.setHeader('cache-control', 'no-store');
    res.redirect(302, buildLoginRedirectPath(requestUrl));
  };
}

export function isProtectedAppRoute(pathname: string): boolean {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';

  return PROTECTED_APP_ROUTES.some(
    (route) =>
      normalizedPath === route || normalizedPath.startsWith(`${route}/`),
  );
}

export function hasAuthSessionCookie(cookieHeader?: string | string[]): boolean {
  const header = Array.isArray(cookieHeader)
    ? cookieHeader.join(';')
    : (cookieHeader ?? '');

  return SESSION_COOKIE_PATTERN.test(header);
}

export function buildLoginRedirectPath(requestUrl: URL): string {
  const redirectTo = `${requestUrl.pathname}${requestUrl.search}`;

  return `/login?redirectTo=${encodeURIComponent(redirectTo)}`;
}
