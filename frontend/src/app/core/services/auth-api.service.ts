import { getUserErrorMessage } from '../../shared/user-error';
import { Injectable } from '@angular/core';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
} from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import {
  ApiAuthUser,
  AuthUser,
} from '../../shared/models/auth.model';

interface ApiCognitoProviders {
  providers: string[];
}

@Injectable({
  providedIn: 'root',
})
export class AuthApiService {
  private readonly authUrl = `${environment.apiUrl}/auth`;

  constructor(private readonly http: HttpClient) {}

  bootstrapCurrentUser(): Observable<AuthUser | null> {
    return this.getCurrentUser().pipe(
      catchError((error) => {
        if (!this.isUnauthorized(error)) {
          return throwError(() => error);
        }

        if (!this.hasXsrfTokenCookie()) {
          return of(null);
        }

        return this.refreshSession().pipe(
          catchError((refreshError) => {
            if (this.isUnauthorized(refreshError)) {
              return of(null);
            }

            return throwError(() => refreshError);
          }),
        );
      }),
    );
  }

  getCurrentUser(): Observable<AuthUser> {
    return this.http
      .get<ApiAuthUser>(`${this.authUrl}/me`, { withCredentials: true })
      .pipe(map((user) => this.normalizeUser(user)));
  }

  buildCognitoLoginUrl(
    provider?: string | null,
    redirectTo?: string | null,
  ): string {
    const params = new URLSearchParams();

    if (provider) {
      params.set('provider', provider);
    }

    if (redirectTo) {
      params.set('redirectTo', redirectTo);
    }

    const queryString = params.toString();

    return `${this.authUrl}/cognito/login${queryString ? `?${queryString}` : ''}`;
  }

  getCognitoProviders(): Observable<string[]> {
    return this.http
      .get<ApiCognitoProviders>(`${this.authUrl}/cognito/providers`)
      .pipe(
        map((response) =>
          response.providers
            .map((provider) => provider.trim())
            .filter(Boolean),
        ),
      );
  }

  refreshSession(): Observable<AuthUser> {
    return this.http
      .post<ApiAuthUser>(
        `${this.authUrl}/refresh`,
        {},
        {
          headers: this.getXsrfHeaders(),
          withCredentials: true,
        },
      )
      .pipe(map((user) => this.normalizeUser(user)));
  }

  logout(): Observable<{ logoutUrl: string }> {
    return this.http.post<{ logoutUrl: string }>(
      `${this.authUrl}/logout`,
      {},
      {
        headers: this.getXsrfHeaders(),
        withCredentials: true,
      },
    );
  }

  getErrorMessage(error: unknown): string {
    return getUserErrorMessage(error);
  }

  isUnauthorized(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 401;
  }

  private hasXsrfTokenCookie(): boolean {
    return this.getXsrfTokenFromCookie() !== null;
  }

  private getXsrfHeaders(): HttpHeaders {
    const xsrfToken = this.getXsrfTokenFromCookie();

    return xsrfToken
      ? new HttpHeaders({ 'x-xsrf-token': xsrfToken })
      : new HttpHeaders();
  }

  private getXsrfTokenFromCookie(): string | null {
    if (typeof document === 'undefined') {
      return null;
    }

    const encodedToken = document.cookie
      .split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith('XSRF-TOKEN='))
      ?.slice('XSRF-TOKEN='.length);

    if (!encodedToken) {
      return null;
    }

    try {
      return decodeURIComponent(encodedToken);
    } catch {
      return encodedToken;
    }
  }

  private normalizeUser(user: ApiAuthUser): AuthUser {
    return {
      ...user,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt),
    };
  }
}
