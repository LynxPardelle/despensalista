import { createAction, props } from '@ngrx/store';
import { AuthUser } from '../../shared/models/auth.model';

export const bootstrapSession = createAction('[Auth] Bootstrap Session');

export const bootstrapSessionSuccess = createAction(
  '[Auth] Bootstrap Session Success',
  props<{ user: AuthUser }>(),
);

export const bootstrapSessionAnonymous = createAction(
  '[Auth] Bootstrap Session Anonymous',
);

export const bootstrapSessionFailure = createAction(
  '[Auth] Bootstrap Session Failure',
  props<{ error: string }>(),
);

export const login = createAction(
  '[Auth] Login',
  props<{ provider?: string | null; redirectTo?: string | null }>(),
);

export const loginSuccess = createAction(
  '[Auth] Login Success',
  props<{ user: AuthUser; redirectTo?: string | null }>(),
);

export const loginFailure = createAction(
  '[Auth] Login Failure',
  props<{ error: string }>(),
);

export const refreshSession = createAction('[Auth] Refresh Session');

export const refreshSessionSuccess = createAction(
  '[Auth] Refresh Session Success',
  props<{ user: AuthUser }>(),
);

export const refreshSessionFailure = createAction(
  '[Auth] Refresh Session Failure',
  props<{ error: string }>(),
);

export const logout = createAction('[Auth] Logout');

export const logoutSuccess = createAction(
  '[Auth] Logout Success',
  props<{ logoutUrl?: string | null }>(),
);

export const logoutFailure = createAction(
  '[Auth] Logout Failure',
  props<{ error: string }>(),
);

export const sessionExpired = createAction(
  '[Auth] Session Expired',
  props<{ error: string }>(),
);

export const googleMfaRequired = createAction(
  '[Auth] Google MFA Required',
  props<{ redirectCurrentRoute: boolean }>(),
);

export const clearFeedback = createAction('[Auth] Clear Feedback');
