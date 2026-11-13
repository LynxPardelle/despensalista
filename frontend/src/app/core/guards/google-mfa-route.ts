import { Router, UrlTree } from '@angular/router';

export function googleMfaReturnUrl(value?: string | null): string | null {
  const path = value?.split(/[?#]/, 1)[0];
  if (!value || (path !== '/pantry' && path !== '/profile') || /[\\\x00-\x1f\x7f-\x9f]/.test(value)) {
    return null;
  }

  try {
    decodeURI(value);
    return value;
  } catch {
    return null;
  }
}

export function googleMfaRoute(router: Router, requestedUrl?: string | null): UrlTree {
  const redirectTo = googleMfaReturnUrl(requestedUrl);
  return router.createUrlTree(['/mfa-google'], {
    queryParams: redirectTo ? { redirectTo } : undefined,
  });
}
