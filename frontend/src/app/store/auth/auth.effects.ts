import { inject, Injectable, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Observable, of, timer } from 'rxjs';
import {
  catchError,
  exhaustMap,
  map,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators';
import { googleMfaReturnUrl, googleMfaRoute } from '../../core/guards/google-mfa-route';
import { AuthApiService, isGoogleMfaRequired } from '../../core/services/auth-api.service';
import * as AuthActions from './auth.actions';
import * as PantryActions from '../pantry/pantry.actions';
import * as ProductActions from '../product/product.actions';

@Injectable()
export class AuthEffects {
  private readonly actions$ = inject(Actions);
  private readonly authApiService = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly ngZone = inject(NgZone);

  readonly bootstrapSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.bootstrapSession),
      exhaustMap(() =>
        this.authApiService.bootstrapCurrentUser().pipe(
          map((user) =>
            user
              ? AuthActions.bootstrapSessionSuccess({ user })
              : AuthActions.bootstrapSessionAnonymous(),
          ),
          catchError((error) =>
            of(isGoogleMfaRequired(error)
              ? AuthActions.googleMfaRequired({ redirectCurrentRoute: false })
              : AuthActions.bootstrapSessionFailure({
                error: this.authApiService.getErrorMessage(error),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  readonly login$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActions.login),
        tap(({ provider, redirectTo }) => {
          globalThis.location.assign(
            this.authApiService.buildCognitoLoginUrl(provider, redirectTo),
          );
        }),
      ),
    { dispatch: false },
  );

  readonly refreshSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.refreshSession),
      exhaustMap(() =>
        this.authApiService.refreshSession().pipe(
          map((user) => AuthActions.refreshSessionSuccess({ user })),
          catchError((error) => {
            if (isGoogleMfaRequired(error)) {
              return of(AuthActions.googleMfaRequired({ redirectCurrentRoute: true }));
            }

            if (this.authApiService.isUnauthorized(error)) {
              return of(
                AuthActions.sessionExpired({
                  error: 'La sesion expiro. Vuelve a iniciar sesion.',
                }),
              );
            }

            return of(
              AuthActions.refreshSessionFailure({
                error: this.authApiService.getErrorMessage(error),
              }),
            );
          }),
        ),
      ),
    ),
  );

  readonly logout$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.logout),
      exhaustMap(() =>
        this.authApiService.logout().pipe(
          map((response) =>
            AuthActions.logoutSuccess({ logoutUrl: response.logoutUrl }),
          ),
          catchError((error) =>
            this.authApiService.isUnauthorized(error)
              ? of(AuthActions.logoutSuccess({ logoutUrl: null }))
              : of(
                  AuthActions.logoutFailure({
                    error: this.authApiService.getErrorMessage(error),
                  }),
                ),
          ),
        ),
      ),
    ),
  );

  readonly scheduleRefresh$ = createEffect(() =>
    this.actions$.pipe(
      ofType(AuthActions.bootstrapSessionSuccess, AuthActions.refreshSessionSuccess),
      switchMap(() =>
        this.sessionRefreshTicker().pipe(
          map(() => AuthActions.refreshSession()),
          takeUntil(
            this.actions$.pipe(
              ofType(
                AuthActions.logout,
                AuthActions.logoutSuccess,
                AuthActions.sessionExpired,
                AuthActions.googleMfaRequired,
                AuthActions.bootstrapSessionAnonymous,
              ),
            ),
          ),
        ),
      ),
    ),
  );

  readonly resetPantryOnSessionEnd$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        AuthActions.logout,
        AuthActions.logoutSuccess,
        AuthActions.sessionExpired,
        AuthActions.googleMfaRequired,
        AuthActions.bootstrapSessionAnonymous,
      ),
      map(() => PantryActions.resetPantry()),
    ),
  );

  readonly resetProductsOnSessionEnd$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        AuthActions.logout,
        AuthActions.logoutSuccess,
        AuthActions.sessionExpired,
        AuthActions.googleMfaRequired,
        AuthActions.bootstrapSessionAnonymous,
      ),
      map(() => ProductActions.resetProducts()),
    ),
  );

  readonly navigateAfterSessionExpired$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActions.sessionExpired),
        tap(() => {
          void this.router.navigateByUrl('/login');
        }),
      ),
    { dispatch: false },
  );

  readonly navigateWhenGoogleMfaRequired$ = createEffect(
    () => this.actions$.pipe(
      ofType(AuthActions.googleMfaRequired),
      tap(({ redirectCurrentRoute }) => {
        if (redirectCurrentRoute && googleMfaReturnUrl(this.router.url)) {
          void this.router.navigateByUrl(googleMfaRoute(this.router, this.router.url), { replaceUrl: true });
        }
      }),
    ),
    { dispatch: false },
  );

  readonly navigateAfterLogoutSuccess$ = createEffect(
    () =>
      this.actions$.pipe(
        ofType(AuthActions.logoutSuccess),
        tap(({ logoutUrl }) => {
          if (logoutUrl) {
            globalThis.location.assign(logoutUrl);
            return;
          }

          void this.router.navigateByUrl('/login');
        }),
      ),
    { dispatch: false },
  );

  private sessionRefreshTicker(): Observable<number> {
    return new Observable<number>((subscriber) => {
      const subscription = this.ngZone.runOutsideAngular(() =>
        timer(10 * 60 * 1000, 10 * 60 * 1000).subscribe({
          next: (value) => this.ngZone.run(() => subscriber.next(value)),
          error: (error) => this.ngZone.run(() => subscriber.error(error)),
          complete: () => this.ngZone.run(() => subscriber.complete()),
        }),
      );

      return () => subscription.unsubscribe();
    });
  }
}
