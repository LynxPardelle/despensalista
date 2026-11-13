import { createReducer, on } from '@ngrx/store';
import * as AuthActions from './auth.actions';
import { initialAuthState } from './auth.state';

export const authReducer = createReducer(
  initialAuthState,
  on(AuthActions.bootstrapSession, (state) => ({
    ...state,
    bootstrapPending: true,
    authError: null,
  })),
  on(
    AuthActions.bootstrapSessionSuccess,
    AuthActions.loginSuccess,
    AuthActions.refreshSessionSuccess,
    (state, { user }) => ({
      ...state,
      sessionStatus: 'authenticated' as const,
      currentUser: user,
      bootstrapPending: false,
      loginPending: false,
      refreshPending: false,
      authError: null,
    }),
  ),
  on(AuthActions.bootstrapSessionAnonymous, (state) => ({
    ...state,
    sessionStatus: 'anonymous' as const,
    currentUser: null,
    bootstrapPending: false,
    refreshPending: false,
    authError: null,
  })),
  on(AuthActions.bootstrapSessionFailure, (state, { error }) => ({
    ...state,
    sessionStatus: 'anonymous' as const,
    currentUser: null,
    bootstrapPending: false,
    authError: error,
  })),
  on(AuthActions.login, (state) => ({
    ...state,
    loginPending: true,
    authError: null,
    infoMessage: null,
  })),
  on(AuthActions.loginFailure, (state, { error }) => ({
    ...state,
    loginPending: false,
    authError: error,
  })),
  on(AuthActions.refreshSession, (state) => ({
    ...state,
    refreshPending: true,
  })),
  on(AuthActions.refreshSessionFailure, (state, { error }) => ({
    ...state,
    refreshPending: false,
    authError: error,
  })),
  on(AuthActions.logout, (state) => ({
    ...state,
    sessionStatus: 'anonymous' as const,
    currentUser: null,
    bootstrapPending: false,
    refreshPending: false,
    authError: null,
    infoMessage: null,
  })),
  on(AuthActions.logoutSuccess, () => ({
    ...initialAuthState,
    sessionStatus: 'anonymous' as const,
  })),
  on(AuthActions.sessionExpired, (_state, { error }) => ({
    ...initialAuthState,
    sessionStatus: 'anonymous' as const,
    authError: error,
  })),
  on(AuthActions.googleMfaRequired, () => ({
    ...initialAuthState,
    sessionStatus: 'google-mfa-required' as const,
  })),
  on(AuthActions.logoutFailure, (state, { error }) => ({
    ...state,
    authError: error,
  })),
  on(AuthActions.clearFeedback, (state) => ({
    ...state,
    authError: null,
    infoMessage: null,
  })),
);
