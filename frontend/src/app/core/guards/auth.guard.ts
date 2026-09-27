import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  ActivatedRouteSnapshot,
  CanActivate,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { combineLatest, Observable } from 'rxjs';
import { filter, map, take, tap } from 'rxjs/operators';
import { AuthFacade } from '../services/auth.facade';

@Injectable({
  providedIn: 'root'
})
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authFacade: AuthFacade,
    private readonly router: Router,
    @Inject(PLATFORM_ID) private readonly platformId: object,
  ) {}

  canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot,
  ): boolean | UrlTree | Observable<boolean | UrlTree> {
    if (!isPlatformBrowser(this.platformId)) {
      return true;
    }

    const authMode =
      route.data['authMode'] === 'anonymous' ? 'anonymous' : 'authenticated';

    if (authMode === 'anonymous' && !this.hasXsrfTokenCookie()) {
      return true;
    }

    return combineLatest([
      this.authFacade.sessionStatus$,
      this.authFacade.bootstrapPending$,
      this.authFacade.refreshPending$,
    ]).pipe(
      tap(([status, bootstrapPending, refreshPending]) => {
        if (status === 'unknown' && !bootstrapPending && !refreshPending) {
          this.authFacade.bootstrap();
        }
      }),
      filter(
        ([status, bootstrapPending, refreshPending]) =>
          status !== 'unknown' && !bootstrapPending && !refreshPending,
      ),
      take(1),
      map(([status]) =>
        authMode === 'anonymous'
          ? this.resolveAnonymousRoute(status, route.queryParamMap?.get('redirectTo'))
          : this.resolveAuthenticatedRoute(status, state.url),
      ),
    );
  }

  private resolveAnonymousRoute(status: string, redirectTo?: string | null): boolean | UrlTree {
    const localRedirect = redirectTo?.startsWith('/') &&
      !redirectTo.startsWith('//') && !/[\\\x00-\x1f\x7f-\x9f]/.test(redirectTo);
    return status === 'authenticated'
      ? localRedirect ? this.router.parseUrl(redirectTo!) : this.router.createUrlTree(['/pantry'])
      : true;
  }

  private resolveAuthenticatedRoute(
    status: string,
    requestedUrl: string,
  ): boolean | UrlTree {
    if (status === 'authenticated') {
      return true;
    }

    return this.router.createUrlTree(['/login'], {
      queryParams: requestedUrl ? { redirectTo: requestedUrl } : undefined,
    });
  }

  private hasXsrfTokenCookie(): boolean {
    return document.cookie
      .split(';')
      .map((cookie) => cookie.trim())
      .some((cookie) => cookie.startsWith('XSRF-TOKEN='));
  }
}
